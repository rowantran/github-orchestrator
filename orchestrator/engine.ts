import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RunStore } from './store.js';
import type { AgentFactory, Dispatch, ExecutionCore, Mode, Phase, PullRequestInfo, Report, Role, RpcAgent, Run, WorkPhase } from './types.js';

const exec = promisify(execFile);
const resources = fileURLToPath(new URL('../../agent-context/runtime/', import.meta.url));
const activePhases = new Set<Phase>(['planning', 'implementing', 'reviewing']);
const terminalPhases = new Set<Phase>(['done', 'closed']);
const roleFor = (phase: WorkPhase): Role => phase === 'reviewing' ? 'reviewer' : 'implementer';
const messageText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const clone = <T>(value: T): T => structuredClone(value);

export interface EngineOptions {
  concurrency?: number;
  maxAttempts?: number;
  maxReviewRounds?: number;
  pollMs?: number;
  runTimeoutMs?: number;
  piCommand?: string;
  piArgs?: string[];
  verifyHead?: (worktree: string, sha: string) => Promise<void>;
  onError?: (error: unknown) => void;
}
interface Active { agent: RpcAgent; dispatch: Dispatch; unsubscribe?: () => void; deadline?: NodeJS.Timeout; dialogs: Map<string, Record<string, unknown>>; }

/** Deterministic task execution; GitHub remains the source of task content and eligibility. */
export class Orchestrator {
  private records = new Map<number, Run>();
  private committed = new Map<number, Run>();
  private persistenceFault?: Error;
  private emergencyStops: Promise<unknown>[] = [];
  private active = new Map<number, Active>();
  private pauseRequests = new Set<number>();
  private chain: Promise<unknown> = Promise.resolve();
  private journalWrites: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closing = false;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly maxReviewRounds: number;
  readonly errors: string[] = [];
  constructor(readonly core: ExecutionCore, readonly store: RunStore, private factory: AgentFactory, private options: EngineOptions = {}) {
    this.concurrency = options.concurrency ?? 3;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxReviewRounds = options.maxReviewRounds ?? 3;
    if (![this.concurrency, this.maxAttempts, this.maxReviewRounds].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Concurrency and retry limits must be positive integers.');
    if (options.runTimeoutMs !== undefined && (!Number.isSafeInteger(options.runTimeoutMs) || options.runTimeoutMs < 1 || options.runTimeoutMs > 2_147_483_647)) throw new Error('Agent deadline must be 1–2147483647 milliseconds.');
  }
  private serial<T>(action: () => Promise<T>, cleanup = false): Promise<T> {
    const next = this.chain.then(() => {
      if (this.persistenceFault && !cleanup) throw this.persistenceFault;
      if (this.closing && !cleanup) throw new Error('Orchestration service is stopping.');
      return action();
    });
    this.chain = next.catch(error => { this.options.onError?.(error); });
    return next;
  }
  private async persist(run: Run): Promise<void> {
    if (this.persistenceFault) throw this.persistenceFault;
    try {
      await this.store.save(run);
      this.committed.set(run.issue, clone(run));
    } catch (error) { throw this.haltPersistence(error); }
  }
  private haltPersistence(error: unknown): Error {
    if (this.persistenceFault) return this.persistenceFault;
    this.persistenceFault = new Error(`Execution persistence failed; service is stopped until restart: ${messageText(error)}`);
    this.records = new Map([...this.committed].map(([issue, saved]) => [issue, clone(saved)]));
    clearTimeout(this.timer);
    // Never execute a transition that was not durably committed. Stop every owned writer.
    for (const live of this.active.values()) {
      live.unsubscribe?.();
      clearTimeout(live.deadline);
      this.emergencyStops.push(live.agent.close().catch(e => this.options.onError?.(e)));
    }
    this.active.clear();
    this.options.onError?.(this.persistenceFault);
    return this.persistenceFault;
  }
  async initialize(): Promise<void> {
    for (const run of await this.store.load()) {
      if (run.repo !== this.core.config.repo) throw new Error('Execution checkpoint belongs to another repository.');
      for (const agent of Object.values(run.agents)) if (['starting', 'working', 'prompting'].includes(agent.status)) agent.status = 'idle';
      this.records.set(run.issue, run);
      this.committed.set(run.issue, clone(run));
    }
  }
  begin(): void {
    if (this.timer) return;
    const interval = this.options.pollMs ?? 15_000;
    if (!Number.isFinite(interval) || interval < 100) throw new Error('Polling interval must be at least 100 milliseconds.');
    const loop = async () => {
      try { await this.tick(); } catch (error) { this.errors.push(messageText(error)); this.options.onError?.(error); }
      if (!this.closing && !this.persistenceFault) this.timer = setTimeout(loop, interval);
    };
    this.timer = setTimeout(loop, 0);
  }
  private visible(saved: Run): Run {
    const run = clone(saved);
    const live = this.active.get(run.issue);
    // Runtime activity is observable even when an input hook is holding a prompt acknowledgement.
    // Only role status/model is overlaid; lifecycle and approval always come from committed state.
    if (live) run.agents[live.dispatch.role] = clone(this.require(run.issue).agents[live.dispatch.role]);
    return run;
  }
  runs(): Run[] { return [...this.committed.values()].map(run => this.visible(run)); }
  getRun(issue: number): Run { this.require(issue); return this.visible(this.committed.get(issue)!); }
  private require(issue: number): Run {
    const run = this.records.get(issue);
    if (!run) throw new Error(`Task #${issue} is not registered. Use gho run ${issue}.`);
    return run;
  }
  async snapshot(): Promise<unknown> {
    const snapshot = await this.core.snapshot();
    return { ...snapshot, orchestration: true, tasks: snapshot.tasks.map(task => ({ ...task, execution: this.records.has(Number(task.number)) ? this.getRun(Number(task.number)) : null })) };
  }
  async start(issue: number, options: { mode?: Mode } = {}): Promise<Run> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('Issue must be a positive integer.');
      const mode = options.mode ?? 'supervised';
      if (!['supervised', 'unsupervised'].includes(mode)) throw new Error('Unknown workflow mode.');
      const existing = this.records.get(issue);
      if (existing) {
        if (existing.mode !== mode) throw new Error('Task already has a different workflow. Pause it before changing its workflow configuration.');
        return clone(existing);
      }
      const task = await this.core.inspectTask(issue);
      if (task.state !== 'OPEN') throw new Error('Cannot start a closed issue.');
      const entry = (await this.core.ready(true)).find(entry => entry.number === issue);
      if (!entry) throw new Error('Issue is not in the configured Project queue assigned to this owner.');
      if (!['ready', 'blocked'].includes(entry.state)) throw new Error('Issue already has manually managed work. Do not enroll a second execution for its branch.');
      const now = new Date().toISOString();
      const run: Run = {
        version: 1, issue, repo: this.core.config.repo, mode, phase: 'queued',
        agents: { implementer: { sessionId: `gho-${issue}-implementer`, status: 'idle' }, reviewer: { sessionId: `gho-${issue}-reviewer`, status: 'idle' } },
        seenFeedback: [], reviewRounds: 0, failures: 0, createdAt: now, updatedAt: now,
      };
      await this.persist(run);
      this.records.set(issue, run);
      return clone(run);
    });
  }
  async approve(issue: number, sha: string, actor = 'cli', source: 'cli' | 'dashboard' = 'cli'): Promise<Run> {
    return this.serial(async () => {
      const run = this.require(issue);
      await this.approveRun(run, sha, actor, source);
      return clone(run);
    });
  }
  private async approveRun(run: Run, sha: string, actor: string, source: 'cli' | 'github' | 'dashboard' | 'automatic'): Promise<void> {
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('Approval requires the full skeleton commit SHA.');
    if (run.phase !== 'awaiting_approval' || this.active.has(run.issue)) throw new Error('Task is not waiting for skeleton approval.');
    const pr = await this.core.inspectPullRequest(run.issue);
    if (!pr || pr.state !== 'OPEN' || pr.headSha !== sha || run.skeletonSha !== sha) throw new Error('Skeleton changed. Refresh the task and approve its current revision.');
    await this.verifyHead(run, sha);
    run.approvedSha = sha;
    run.implementationStarted = false;
    run.approval = { sha, actor, source, at: new Date().toISOString() };
    run.phase = 'implementing';
    run.error = undefined;
    run.failures = 0;
    run.dispatch = undefined;
    await this.persist(run);
  }
  async pause(issue: number): Promise<Run> {
    if (terminalPhases.has(this.require(issue).phase)) throw new Error('Task is already finished.');
    this.pauseRequests.add(issue); // Also prevents dispatch while provisioning is still pending.
    const pendingInput = this.active.get(issue);
    if (pendingInput) await pendingInput.agent.close(); // Unblock startup/input hooks before joining the lifecycle queue.
    return this.serial(async () => {
      const run = this.require(issue);
      if (terminalPhases.has(run.phase)) throw new Error('Task is already finished.');
      if (run.phase !== 'paused') { run.resumePhase = run.phase; run.phase = 'paused'; }
      await this.persist(run); // Gate recovery before terminating the process.
      await this.stopAgent(run);
      this.pauseRequests.delete(issue);
      return clone(run);
    });
  }
  async resume(issue: number): Promise<Run> {
    return this.serial(async () => {
      const run = clone(this.require(issue));
      if (!['paused', 'blocked'].includes(run.phase)) throw new Error('Task is not paused or blocked.');
      run.phase = run.resumePhase ?? (run.approvedSha ? 'implementing' : run.worktree ? 'planning' : 'queued');
      run.resumePhase = undefined;
      const pending = run.pendingMessages ?? [];
      if (run.phase === 'awaiting_approval' && pending.some(message => message.role === 'implementer')) {
        run.phase = 'planning'; run.skeletonSha = undefined; run.approvedSha = undefined; run.dispatch = undefined;
      } else if (run.phase === 'ready_to_merge' && pending.length) {
        if (run.pr && this.core.draftPullRequest) await this.core.draftPullRequest(run.pr);
        run.phase = pending.some(message => message.role === 'implementer') ? 'implementing' : 'reviewing';
        run.reviewedSha = undefined; run.dispatch = undefined;
      }
      run.error = undefined;
      run.failures = 0;
      run.retryAt = undefined;
      if (run.dispatch) run.dispatch.attempts = 0;
      await this.persist(run);
      this.records.set(issue, run);
      return clone(run);
    });
  }
  async message(issue: number, role: Role, text: string): Promise<Run> {
    return this.serial(async () => {
      if (!text.trim() || text.length > 64_000) throw new Error('Message must contain 1–64000 characters.');
      const run = this.require(issue);
      if (!['implementer', 'reviewer'].includes(role)) throw new Error('Unknown agent role.');
      if (terminalPhases.has(run.phase)) throw new Error('Cannot message a finished task.');
      if ((run.pendingMessages?.length ?? 0) >= 100) throw new Error('Too many pending messages; wait for the agent to consume them.');
      const id = randomUUID();
      const pending = { id, marker: `[gho-message:${id}]`, role, text };
      const live = this.active.get(issue);
      if (live) {
        if (live.dispatch.role !== role) throw new Error('That agent is not currently assigned to this phase.');
        (run.pendingMessages ??= []).push(pending);
        await this.persist(run); // Admission is durable before Pi can accept or queue the nudge.
        await this.store.appendEvent(issue, role, { type: 'operator_message', id, text, delivery: 'pending' });
        await live.agent.steer(`${pending.marker}\n${text}`);
        await this.store.appendEvent(issue, role, { type: 'operator_message_accepted', id });
        return clone(run); // Acceptance is not consumption; keep it until it appears in the saved context.
      }
      if (run.phase === 'paused' || run.phase === 'blocked') {
        (run.pendingMessages ??= []).push(pending);
        await this.persist(run);
        return clone(run); // A message does not implicitly unpause work or approve a gate.
      }
      if (role === 'reviewer') {
        if (!['reviewing', 'ready_to_merge'].includes(run.phase)) throw new Error('No review is available yet.');
        run.phase = 'reviewing';
        run.reviewedSha = undefined;
      } else if (run.phase === 'awaiting_approval') {
        run.phase = 'planning';
        run.skeletonSha = undefined;
        run.approvedSha = undefined;
      } else if (run.phase === 'ready_to_merge') {
        if (run.pr && this.core.draftPullRequest) await this.core.draftPullRequest(run.pr);
        run.phase = 'implementing';
        run.reviewedSha = undefined;
      } else if (run.phase === 'reviewing') {
        throw new Error('Reviewer owns the worktree. Pause or wait for review before messaging the implementer.');
      }
      (run.pendingMessages ??= []).push(pending);
      run.dispatch = undefined;
      await this.persist(run);
      await this.store.appendEvent(issue, role, { type: 'operator_message', id, text, delivery: 'queued' });
      return clone(run);
    });
  }
  async respond(issue: number, role: Role, response: Record<string, unknown>): Promise<unknown> {
    if (this.persistenceFault) throw this.persistenceFault;
    const live = this.active.get(issue);
    if (!live || live.dispatch.role !== role || typeof response.id !== 'string' || !live.dialogs.has(response.id)) throw new Error('Dialog is no longer active.');
    // Input hooks can wait for this response before acknowledging prompt/steer. Never queue it behind them.
    await live.agent.respond(response);
    live.dialogs.delete(response.id);
    const run = this.require(issue);
    run.agents[role].status = 'working';
    void this.serial(async () => { if (this.active.get(issue) === live) await this.persist(run); });
    return { accepted: true };
  }
  async agent(issue: number, role: Role): Promise<unknown> {
    const run = this.require(issue);
    if (!['implementer', 'reviewer'].includes(role)) throw new Error('Unknown agent role.');
    const live = this.active.get(issue);
    const events = await this.store.events(issue, role);
    const active = live?.dispatch.role === role ? live : undefined;
    let messages: unknown = [];
    if (active) {
      try { messages = await active.agent.getMessages(); } catch { /* The event journal remains available after a disconnect. */ }
    }
    if (!Array.isArray(messages)) messages = (messages as { messages?: unknown[] } | undefined)?.messages ?? [];
    if (!(messages as unknown[]).length) messages = events.filter(e => e.type === 'message_end').map(e => e.message);
    return { role, ...run.agents[role], messages, events, dialogs: active ? [...active.dialogs.values()] : [] };
  }
  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.closing) return;
      const unavailable = new Set<number>();
      for (const run of this.records.values()) {
        if (terminalPhases.has(run.phase)) continue;
        try { await this.reconcile(run); }
        catch (error) {
          unavailable.add(run.issue);
          run.error = messageText(error);
          await this.persist(run);
          this.options.onError?.(error);
        }
      }
      const queued = [...this.records.values()].filter(run => run.phase === 'queued');
      const ready = queued.length ? await this.core.ready(true) : [];
      for (const run of this.records.values()) {
        if (this.closing || this.active.size >= this.concurrency) break;
        if (this.pauseRequests.has(run.issue) || unavailable.has(run.issue) || this.active.has(run.issue) || (run.retryAt && Date.parse(run.retryAt) > Date.now())) continue;
        try {
          if (run.phase === 'queued') {
            const entry = ready.find(entry => entry.number === run.issue);
            let created = run.provisioning ? await this.core.recoverWorktree?.(run.issue) : null;
            if (!created) {
              if (entry?.state !== 'ready') continue;
              run.provisioning = true;
              await this.persist(run);
              created = await this.core.createWorktree(run.issue);
            }
            run.worktree = created.path;
            run.branch = created.branch;
            run.baseBranch = created.base_branch;
            run.provisioning = false;
            run.phase = 'planning';
            await this.persist(run);
          }
          if (activePhases.has(run.phase)) {
            if (run.phase === 'reviewing' && run.reviewedSha) continue; // Only waiting on CI.
            await this.dispatch(run);
          }
        } catch (error) { await this.fail(run, error); }
      }
    });
  }
  private async reconcile(run: Run): Promise<void> {
    const task = await this.core.inspectTask(run.issue);
    if (task.state === 'CLOSED') { await this.finish(run, task.completed ? 'done' : 'closed'); return; }
    if (!run.worktree) return;
    const pr = await this.core.inspectPullRequest(run.issue);
    if (pr?.state === 'MERGED' || pr?.state === 'CLOSED') { await this.finish(run, pr.state === 'MERGED' ? 'done' : 'closed'); return; }
    const live = this.active.get(run.issue);
    if (live) {
      if (live.dispatch.startedAt && Date.now() - Date.parse(live.dispatch.startedAt) > (this.options.runTimeoutMs ?? 60 * 60_000)) {
        await this.fail(run, new Error('Agent exceeded its run deadline; retry budget applies.'));
      }
      return;
    }
    if (run.phase === 'paused' || run.phase === 'blocked') return;
    if (run.retryAt && Date.parse(run.retryAt) > Date.now()) return;
    if (run.dispatch) {
      try {
        const report = await this.readReport(run.dispatch);
        if (report) { await this.acceptReport(run, report); return; }
      } catch (error) { await this.rejectReport(run, error); return; }
    }
    if (!pr) return;
    if (run.phase === 'awaiting_approval' && pr.headSha !== run.skeletonSha) {
      run.phase = 'planning'; run.skeletonSha = undefined; run.approvedSha = undefined; run.dispatch = undefined;
      run.error = 'Skeleton revision changed; a new phase report and approval are required.';
      await this.persist(run); return;
    }
    await this.applyFeedback(run, pr);
    if (run.phase === 'awaiting_approval' && run.mode === 'unsupervised' && run.skeletonSha) {
      await this.approveRun(run, run.skeletonSha, 'workflow', 'automatic');
    }
    if (run.phase === 'reviewing' && run.reviewedSha) await this.tryPublish(run, pr);
    if (run.phase === 'ready_to_merge' && (pr.headSha !== run.reviewedSha || pr.checks === 'failed')) {
      if (this.core.draftPullRequest) await this.core.draftPullRequest(pr.number);
      run.phase = pr.checks === 'failed' ? 'implementing' : 'reviewing';
      run.reviewedSha = undefined;
      run.dispatch = undefined;
      await this.persist(run);
    }
  }
  private async applyFeedback(run: Run, pr: PullRequestInfo): Promise<void> {
    const feedback = pr.feedback.filter(f => !run.seenFeedback.includes(f.id) && !f.body.trimStart().startsWith('[agent:]'));
    for (const item of feedback) {
      const approval = /^\/gho approve ([a-f0-9]{40,64})\s*$/i.exec(item.body.trim());
      if (approval?.[1]) {
        if (run.phase === 'awaiting_approval' && item.author.toLowerCase() === this.core.config.owner.toLowerCase() && approval[1] === run.skeletonSha) {
          await this.approveRun(run, approval[1], item.author, 'github');
        }
      } else if (item.body.trim()) {
        run.feedback = [run.feedback, item.body].filter(Boolean).join('\n\n');
        if (run.phase === 'awaiting_approval') { run.phase = 'planning'; run.skeletonSha = undefined; run.approvedSha = undefined; }
        else if (run.phase === 'ready_to_merge' || run.phase === 'reviewing') {
          if (!pr.draft && this.core.draftPullRequest) await this.core.draftPullRequest(pr.number);
          run.phase = 'implementing'; run.reviewedSha = undefined; run.dispatch = undefined;
        }
      }
      run.seenFeedback.push(item.id);
      await this.persist(run);
    }
  }
  private async finish(run: Run, phase: 'done' | 'closed'): Promise<void> {
    run.phase = phase;
    run.dispatch = undefined;
    await this.persist(run);
    await this.stopAgent(run);
  }
  private async verifyHead(run: Run, sha: string): Promise<void> {
    if (!run.worktree) throw new Error('Task has no worktree.');
    if (this.options.verifyHead) return this.options.verifyHead(run.worktree, sha);
    const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: run.worktree, timeout: 15_000 })).stdout.trim();
    if (head !== sha) throw new Error('Worktree HEAD does not match the pushed PR revision.');
    const dirty = (await exec('git', ['status', '--porcelain'], { cwd: run.worktree, timeout: 15_000 })).stdout.trim();
    if (dirty) throw new Error('Worktree contains uncommitted changes. Commit and push before reporting or approving.');
  }
  private async dispatch(run: Run): Promise<void> {
    if (this.closing || this.pauseRequests.has(run.issue)) return;
    const phase = run.phase as WorkPhase;
    const role = roleFor(phase);
    if (!run.worktree) throw new Error('Missing execution worktree.');
    const pr = phase === 'planning' ? null : await this.core.inspectPullRequest(run.issue);
    if (phase !== 'planning' && (!pr || pr.state !== 'OPEN')) throw new Error('The task needs an open draft PR before proceeding.');
    if (phase === 'implementing' && !run.approvedSha) throw new Error('Implementation is not authorized without a recorded skeleton approval.');
    if (phase === 'implementing' && !run.implementationStarted && !run.dispatch) {
      await this.validateInitialImplementation(run, pr!);
    }
    if (phase === 'reviewing') {
      await this.verifyHead(run, pr!.headSha);
      run.reviewTargetSha = pr!.headSha;
    }
    const recovering = !!run.dispatch;
    if (!run.dispatch) {
      const id = randomUUID();
      const directory = join(run.worktree, '.gho', 'reports');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      run.dispatch = { id, phase, role, attempts: 0, reportPath: join(directory, `${id}.json`), feedback: run.feedback };
      run.feedback = undefined;
    }
    const dispatch = run.dispatch;
    if (dispatch.attempts >= this.maxAttempts) { await this.block(run, 'Agent retry limit reached.'); return; }
    dispatch.attempts++;
    dispatch.startedAt = new Date().toISOString();
    const models = this.core.config.agents;
    const model = phase === 'planning' ? models.planner_model : role === 'reviewer' ? models.reviewer_model : models.implementer_model;
    run.agents[role].model = model;
    run.agents[role].status = 'starting';
    await this.persist(run);
    if (this.closing || this.pauseRequests.has(run.issue)) return;
    const agent = this.factory({ cwd: run.worktree, sessionId: run.agents[role].sessionId, sessionDir: join(run.worktree, '.gho', 'sessions'), role,
      model, command: this.options.piCommand, args: this.options.piArgs, instructionsPath: join(resources, role === 'reviewer' ? 'reviewer.md' : 'worker.md'),
      reportPath: dispatch.reportPath, phaseToken: dispatch.id });
    const live: Active = { agent, dispatch: clone(dispatch), dialogs: new Map() };
    this.active.set(run.issue, live);
    live.deadline = setTimeout(() => {
      if (this.active.get(run.issue) !== live) return;
      // This timer must not wait behind a prompt's input hook in the serial lifecycle queue.
      void live.agent.close().catch(error => this.options.onError?.(error)).finally(() => {
        void this.serial(async () => { if (this.active.get(run.issue) === live) await this.fail(run, new Error('Agent exceeded its run deadline.')); });
      });
    }, this.options.runTimeoutMs ?? 60 * 60_000);
    const unsubscribe = agent.onEvent(event => this.onEvent(run.issue, live, event));
    if (unsubscribe) live.unsubscribe = unsubscribe;
    try {
      await agent.start();
      if (this.closing || this.pauseRequests.has(run.issue)) { await this.stopAgent(run); return; }
      run.agents[role].status = 'working';
      await this.persist(run);
      await this.reconcileMessages(run, agent, role);
      if (phase === 'implementing' && !run.implementationStarted) {
        // A lost RPC acknowledgement is resolved from the saved user prompt, not from a launch attempt.
        const history = await agent.getMessages();
        const messages = Array.isArray(history) ? history : (history as { messages?: unknown[] })?.messages ?? [];
        const admitted = messages.some(message => (message as { role?: string }).role === 'user' && JSON.stringify(message).includes(dispatch.id));
        if (admitted) { run.implementationStarted = true; await this.persist(run); }
        else {
          const current = await this.core.inspectPullRequest(run.issue);
          if (!current || current.state !== 'OPEN') throw new Error('Implementation requires an open PR.');
          await this.validateInitialImplementation(run, current);
        }
      }
      const task = await this.core.inspectTask(run.issue);
      const context = { task, repo: run.repo, branch: run.branch, baseBranch: run.baseBranch, phase, mode: run.mode, skeletonSha: run.skeletonSha,
        approvedSha: run.approvedSha, reviewTargetSha: run.reviewTargetSha, pullRequest: pr, feedback: dispatch.feedback, phaseToken: dispatch.id,
        operatorMessages: run.pendingMessages?.filter(message => message.role === role) };
      const template = await readFile(join(resources, recovering ? 'resume-turn.md' : `${phase}-turn.md`), 'utf8');
      const prompt = template.replace(/^<!--[^]*?-->\s*/, '').replace('{{context}}', () => JSON.stringify(context, null, 2));
      if (this.closing || this.pauseRequests.has(run.issue)) { await this.stopAgent(run); return; }
      const acceptance = await agent.prompt(prompt) as { disposition?: string } | undefined;
      if (acceptance?.disposition === 'handled') throw new Error('An extension handled the phase prompt without starting work.');
      if (phase === 'implementing' && !run.implementationStarted) {
        run.implementationStarted = true;
        await this.persist(run);
      }
    } catch (error) {
      await this.stopAgent(run);
      throw error;
    }
  }
  private async validateInitialImplementation(run: Run, pr: PullRequestInfo): Promise<void> {
    if (pr.headSha !== run.approvedSha) {
      run.phase = 'planning'; run.skeletonSha = undefined; run.approvedSha = undefined; run.dispatch = undefined;
      await this.persist(run);
      throw new Error('Skeleton changed after approval and before implementation; plan and approve its new revision.');
    }
    await this.verifyHead(run, run.approvedSha!);
  }
  private onEvent(issue: number, live: Active, event: Record<string, unknown>): void {
    const role = live.dispatch.role;
    this.journalWrites = this.journalWrites.then(async () => {
      if (!this.persistenceFault) await this.store.appendEvent(issue, role, event);
    }).catch(error => { this.haltPersistence(error); });
    if (this.active.get(issue) !== live || this.closing || this.pauseRequests.has(issue)) return;
    if (event.type === 'driver_ready') {
      const state = event.state as { model?: { provider?: string; id?: string } } | undefined;
      if (state?.model?.provider && state.model.id) this.require(issue).agents[role].model = `${state.model.provider}/${state.model.id}`;
    }
    if (event.type === 'extension_ui_request' && typeof event.id === 'string' && ['select','confirm','input','editor'].includes(String(event.method))) {
      live.dialogs.set(event.id, event);
      const run = this.require(issue);
      run.agents[role].status = 'prompting';
      run.agents[role].settlement = randomUUID();
      void this.serial(async () => { if (this.active.get(issue) === live) await this.persist(run); });
    }
    if (event.type === 'agent_settled') {
      void this.serial(async () => {
        if (this.active.get(issue) !== live) return;
        const run = this.require(issue);
        try {
          await this.reconcileMessages(run, live.agent, role);
          await this.stopAgent(run);
          if (!activePhases.has(run.phase)) return;
          const report = await this.readReport(live.dispatch);
          if (!report) { await this.fail(run, new Error('Agent settled without a phase report.')); return; }
          await this.acceptReport(run, report);
        } catch (error) { await this.rejectReport(run, error); }
      });
    } else if (event.type === 'process_exit' || event.type === 'exit' || event.type === 'driver_error') {
      void this.serial(async () => {
        if (this.active.get(issue) === live) await this.fail(this.require(issue), new Error('Pi process exited before the phase settled.'));
      });
    }
  }
  private async readReport(dispatch: Dispatch): Promise<Report | null> {
    let report: Report;
    try { report = JSON.parse(await readFile(dispatch.reportPath, 'utf8')) as Report; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (report.phaseToken !== dispatch.id || typeof report.summary !== 'string') throw new Error('Agent report has an invalid phase identity or summary.');
    return report;
  }
  private async acceptReport(run: Run, report: Report): Promise<void> {
    if (!run.dispatch || report.phaseToken !== run.dispatch.id) throw new Error('Report belongs to an earlier phase.');
    if (run.pendingMessages?.some(message => message.role === run.dispatch!.role)) {
      // A queued nudge can outlive Pi's last turn or our process. Do not cross a gate before it is consumed.
      run.feedback = run.dispatch.feedback;
      run.dispatch = undefined;
      run.reviewedSha = undefined;
      run.retryAt = undefined;
      await this.persist(run);
      return;
    }
    if (report.kind === 'needs_input') { run.dispatch = undefined; await this.block(run, report.summary); return; }
    const pr = await this.core.inspectPullRequest(run.issue);
    if (!pr || pr.state !== 'OPEN') throw new Error('Agent reported completion without an open PR.');
    if (pr.head !== run.branch || pr.base !== run.baseBranch) throw new Error('PR branch or base does not match the execution.');
    await this.verifyHead(run, pr.headSha);
    if (run.phase === 'planning' && report.kind === 'skeleton_ready') {
      if (!pr.draft) throw new Error('Skeleton PR must remain a draft.');
      run.skeletonSha = pr.headSha;
      run.pr = pr.number; run.prUrl = pr.url;
      run.phase = 'awaiting_approval';
      run.dispatch = undefined;
      run.error = undefined;
      run.failures = 0;
      await this.persist(run);
      if (run.mode === 'unsupervised') await this.approveRun(run, pr.headSha, 'workflow', 'automatic');
      return;
    }
    if (run.phase === 'implementing' && report.kind === 'implementation_ready') {
      if (!run.approvedSha) throw new Error('Implementation has no recorded skeleton approval.');
      if (!pr.draft && this.core.draftPullRequest) await this.core.draftPullRequest(pr.number);
      run.phase = 'reviewing'; run.reviewedSha = undefined;
    } else if (run.phase === 'reviewing' && ['review_passed', 'changes_requested'].includes(report.kind)) {
      if (pr.headSha !== run.reviewTargetSha) throw new Error('PR changed during review. Review its new revision.');
      if (report.kind === 'changes_requested') {
        run.reviewRounds++;
        if (run.reviewRounds > this.maxReviewRounds) { run.dispatch = undefined; await this.block(run, 'Review fix limit reached.'); return; }
        run.feedback = [report.summary, ...(report.findings ?? [])].join('\n');
        run.phase = 'implementing';
      } else { run.reviewedSha = pr.headSha; }
    } else throw new Error(`Unexpected report ${report.kind} for phase ${run.phase}.`);
    run.dispatch = undefined;
    run.error = undefined;
    run.failures = 0;
    run.retryAt = undefined;
    await this.persist(run);
    if (run.phase === 'reviewing' && run.reviewedSha) await this.tryPublish(run, pr);
  }
  private async tryPublish(run: Run, pr: PullRequestInfo): Promise<void> {
    const latest = await this.core.inspectPullRequest(run.issue);
    if (!latest || latest.state !== 'OPEN') return;
    await this.applyFeedback(run, latest);
    if (run.phase !== 'reviewing') return;
    if (run.pendingMessages?.length) {
      run.phase = run.pendingMessages.some(message => message.role === 'implementer') ? 'implementing' : 'reviewing';
      run.reviewedSha = undefined;
      await this.persist(run); return;
    }
    pr = latest;
    if (run.reviewedSha !== pr.headSha) { run.reviewedSha = undefined; await this.persist(run); return; }
    if (pr.checks === 'pending') return;
    if (pr.checks === 'failed') {
      run.reviewRounds++;
      if (run.reviewRounds > this.maxReviewRounds) { await this.block(run, 'CI fix limit reached.'); return; }
      run.phase = 'implementing'; run.reviewedSha = undefined;
      run.feedback = JSON.stringify({ checks: pr.checks, pullRequest: pr.url });
      await this.persist(run); return;
    }
    // Re-read immediately before publishing; never publish a newer unreviewed revision.
    const current = await this.core.inspectPullRequest(run.issue);
    if (!current || current.state !== 'OPEN' || current.headSha !== run.reviewedSha || !['passed','none'].includes(current.checks)) return;
    await this.applyFeedback(run, current);
    if (run.phase !== 'reviewing') return;
    if (current.draft) await this.core.publishPullRequest(current.number);
    run.phase = 'ready_to_merge';
    await this.persist(run);
  }
  private async reconcileMessages(run: Run, agent: RpcAgent, role: Role): Promise<void> {
    if (!run.pendingMessages?.some(message => message.role === role)) return;
    const transcript = JSON.stringify(await agent.getMessages());
    const pending = run.pendingMessages.filter(message => message.role !== role || !transcript.includes(message.marker));
    if (pending.length !== run.pendingMessages.length) { run.pendingMessages = pending; await this.persist(run); }
  }
  private async stopAgent(run: Run): Promise<void> {
    const live = this.active.get(run.issue);
    if (!live) return;
    this.active.delete(run.issue);
    clearTimeout(live.deadline);
    live.unsubscribe?.();
    try { await live.agent.close(); }
    finally {
      run.agents[live.dispatch.role].status = 'settled';
      run.agents[live.dispatch.role].settlement = randomUUID();
      await this.persist(run);
    }
  }
  private async block(run: Run, error: string): Promise<void> {
    run.resumePhase = run.phase;
    run.phase = 'blocked';
    run.error = error;
    await this.persist(run);
    await this.stopAgent(run);
  }
  private async rejectReport(run: Run, error: unknown): Promise<void> {
    run.feedback = JSON.stringify({ previousFeedback: run.dispatch?.feedback, reportRejected: messageText(error) });
    run.dispatch = undefined;
    await this.fail(run, error);
  }
  private async fail(run: Run, error: unknown): Promise<void> {
    await this.stopAgent(run);
    if (this.closing || this.pauseRequests.has(run.issue)) return;
    run.error = messageText(error);
    run.failures++;
    if (run.failures >= this.maxAttempts || (run.dispatch?.attempts ?? 0) >= this.maxAttempts) await this.block(run, run.error);
    else {
      run.retryAt = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** (run.failures - 1))).toISOString();
      await this.persist(run);
    }
  }
  async flush(): Promise<void> { await this.chain; await this.journalWrites; }
  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    // Closing RPC stdin releases any input hook whose prompt acceptance is holding the queue.
    await Promise.allSettled([...this.active.values()].map(live => live.agent.close()));
    await this.serial(async () => {
      const results = await Promise.allSettled([...this.active.keys()].map(issue => this.stopAgent(this.require(issue))));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }, true);
    await this.journalWrites;
    await Promise.allSettled(this.emergencyStops);
  }
}
