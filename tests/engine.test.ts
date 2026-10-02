import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../orchestrator/engine.js';
import { RunStore, acquireLock } from '../orchestrator/store.js';
import type { AgentOptions, ExecutionCore, PullRequestInfo, Report, RpcAgent } from '../orchestrator/types.js';

const skeleton = 'a'.repeat(40), implementation = 'b'.repeat(40), revision = 'c'.repeat(40);
class FakeAgent implements RpcAgent {
  listeners = new Set<(e: Record<string, unknown>) => void>();
  prompts: string[] = []; nudges: string[] = []; closed = false;
  constructor(readonly options: AgentOptions, readonly history: unknown[] = []) {}
  async start() {}
  async prompt(text: string) { this.prompts.push(text); this.history.push({ role: 'user', content: text }); }
  async steer(text: string) { this.nudges.push(text); }
  async abort() {}
  async close() { this.closed = true; }
  async getMessages() { return { messages: [...this.history, { role: 'assistant', content: [{ type: 'text', text: 'Working' }] }] }; }
  async getState() { return {}; }
  async respond(_response: Record<string, unknown>) {}
  onEvent(listener: (e: Record<string, unknown>) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: Record<string, unknown>) { for (const listener of this.listeners) listener(event); }
  async report(kind: Report['kind'], summary = 'Verified') {
    for (const text of this.nudges) this.history.push({ role: 'user', content: text });
    this.nudges = [];
    await writeFile(this.options.reportPath, JSON.stringify({ phaseToken: this.options.phaseToken, kind, summary }));
    this.emit({ type: 'agent_settled' });
  }
}
async function fixture(t: { after(fn: () => unknown): void }, options: { concurrency?: number; maxReviewRounds?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gho-engine-'));
  const agents: FakeAgent[] = [];
  let ready = true, closed = false, provisioned = 0, publishes = 0;
  let nextStartFails = false, nextPromptHook = false, loseNextAcceptance = false;
  const pr: PullRequestInfo = { number: 100, url: 'https://github.com/owner/repo/pull/100', headSha: skeleton, head: 'owner/gh-1', base: 'main', draft: true, state: 'OPEN', checks: 'passed', feedback: [] };
  const core: ExecutionCore = {
    config: { repo: 'owner/repo', owner: 'owner', checkout: root, agents: { planner_model: 'provider/planner', implementer_model: 'provider/coder', reviewer_model: 'provider/reviewer' } },
    async ready() { return [{ number: 1, state: ready ? 'ready' : 'blocked' }, { number: 2, state: 'ready' }]; },
    async snapshot() { return { tasks: [{ number: 1 }], repo: 'owner/repo' }; },
    async createWorktree(issue) { provisioned++; return { path: root, branch: `owner/gh-${issue}`, base_branch: 'main', brief: join(root, 'brief.md') }; },
    async inspectTask(number) { return { number, title: 'Task', body: 'Verify task', state: closed ? 'CLOSED' : 'OPEN', completed: closed }; },
    async inspectPullRequest() { return structuredClone(pr); },
    async publishPullRequest() { publishes++; pr.draft = false; },
    async draftPullRequest() { pr.draft = true; },
  };
  const store = new RunStore(join(root, 'runtime'));
  const histories = new Map<string, unknown[]>();
  const factory = (options: AgentOptions) => {
    let history = histories.get(options.sessionId);
    if (!history) { history = []; histories.set(options.sessionId, history); }
    const agent = new FakeAgent(options, history);
    if (nextStartFails) { nextStartFails = false; agent.start = async () => { throw new Error('startup failed before prompting'); }; }
    if (loseNextAcceptance) {
      loseNextAcceptance = false;
      const prompt = agent.prompt.bind(agent);
      agent.prompt = async text => { await prompt(text); throw new Error('lost acknowledgement'); };
    }
    if (nextPromptHook) {
      nextPromptHook = false;
      const prompt = agent.prompt.bind(agent);
      let respond: (() => void) | undefined, cancel: ((error: Error) => void) | undefined;
      agent.prompt = async text => {
        const answer = new Promise<void>((resolve, reject) => { respond = resolve; cancel = reject; });
        agent.emit({ type: 'extension_ui_request', id: 'input-hook', method: 'confirm' });
        await answer; await prompt(text);
      };
      agent.respond = async () => { respond?.(); };
      agent.close = async () => { agent.closed = true; cancel?.(new Error('closed during input')); };
    }
    agents.push(agent); return agent;
  };
  let engine = new Orchestrator(core, store, factory, { verifyHead: async () => {}, ...options });
  await engine.initialize();
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return {
    get engine() { return engine; }, core, store, agents, pr,
    setReady(value: boolean) { ready = value; }, setClosed() { closed = true; },
    failNextStart() { nextStartFails = true; }, holdNextPrompt() { nextPromptHook = true; }, loseNextAcceptance() { loseNextAcceptance = true; },
    get provisioned() { return provisioned; }, get publishes() { return publishes; },
    latest() { return agents.at(-1)!; },
    async report(kind: Report['kind']) { await agents.at(-1)!.report(kind); await engine.flush(); },
    async restart() { await engine.close(); engine = new Orchestrator(core, store, factory, { verifyHead: async () => {}, ...options }); await engine.initialize(); },
  };
}

test('supervised skeleton gates implementation; model changes but session identity does not', async t => {
  const f = await fixture(t);
  await f.engine.start(1);
  await f.engine.tick();
  const planner = f.latest();
  assert.equal(planner.options.model, 'provider/planner');
  await f.report('skeleton_ready');
  assert.equal(f.engine.getRun(1).phase, 'awaiting_approval');
  await f.engine.tick();
  assert.equal(f.agents.length, 1);
  await assert.rejects(f.engine.approve(1, 'short'), /full skeleton/);
  await assert.rejects(f.engine.approve(1, implementation), /changed/);
  await f.engine.approve(1, skeleton, 'supervisor agent');
  await f.engine.tick();
  assert.equal(f.latest().options.sessionId, planner.options.sessionId);
  assert.equal(f.latest().options.model, 'provider/coder');
  assert.notEqual(f.latest().options.phaseToken, planner.options.phaseToken);
  f.pr.headSha = implementation;
  await f.report('implementation_ready');
  await f.engine.tick();
  assert.equal(f.latest().options.role, 'reviewer');
  assert.notEqual(f.latest().options.sessionId, planner.options.sessionId);
  await f.report('review_passed');
  assert.equal(f.engine.getRun(1).phase, 'ready_to_merge');
  assert.equal(f.publishes, 1);
  assert.equal(f.pr.state, 'OPEN'); // Nothing in the service can merge.
});

test('unsupervised still commits/reports skeleton and uses a recorded automatic gate', async t => {
  const f = await fixture(t);
  await f.engine.start(1, { mode: 'unsupervised' });
  await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'planning');
  await f.report('skeleton_ready');
  assert.equal(f.engine.getRun(1).phase, 'implementing');
  assert.equal(f.engine.getRun(1).approval?.source, 'automatic');
  assert.equal(f.engine.getRun(1).approvedSha, skeleton);
});

test('waiting approval survives restart; active interrupted phases resume the same session', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick();
  const original = f.latest();
  await f.restart(); await f.engine.tick();
  assert.equal(f.latest().options.sessionId, original.options.sessionId);
  assert.match(f.latest().prompts[0]!, /interrupted/);
  await f.report('skeleton_ready');
  await f.restart(); await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'awaiting_approval');
  assert.equal(f.agents.length, 2);
  assert.equal(f.provisioned, 1);
});

test('a saved phase report is recovered without replaying the worker', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick();
  const options = f.latest().options;
  await writeFile(options.reportPath, JSON.stringify({ phaseToken: options.phaseToken, kind: 'skeleton_ready', summary: 'done' }));
  await f.restart(); await f.engine.tick();
  assert.equal(f.agents.length, 1);
  assert.equal(f.engine.getRun(1).phase, 'awaiting_approval');
});

test('revision-bound GitHub approval checks author; ordinary feedback never grants approval', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.report('skeleton_ready');
  f.pr.feedback.push({ id: '1', author: 'outsider', body: `/gho approve ${skeleton}`, submittedAt: new Date().toISOString() });
  await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'awaiting_approval');
  f.pr.feedback.push({ id: '2', author: 'owner', body: `/gho approve ${skeleton}`, submittedAt: new Date().toISOString() });
  await f.engine.tick();
  assert.equal(f.engine.getRun(1).approvedSha, skeleton);
  assert.equal(f.engine.getRun(1).approval?.source, 'github');
});

test('nudging an idle planner revokes pending revision and does not bypass the human gate', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.message(1, 'implementer', 'Change the interface');
  assert.equal(f.engine.getRun(1).phase, 'planning');
  assert.equal(f.engine.getRun(1).approvedSha, undefined);
  await f.engine.tick();
  assert.match(f.latest().prompts[0]!, /Change the interface/);
  f.pr.headSha = revision;
  await f.report('skeleton_ready');
  await assert.rejects(f.engine.approve(1, skeleton), /changed/);
  assert.equal(f.engine.getRun(1).skeletonSha, revision);
});

test('review findings return to the implementation session; pending CI blocks publication', async t => {
  const f = await fixture(t);
  await f.engine.start(1, { mode: 'unsupervised' }); await f.engine.tick(); await f.report('skeleton_ready');
  const session = f.latest().options.sessionId;
  await f.engine.tick(); f.pr.headSha = implementation; await f.report('implementation_ready'); await f.engine.tick();
  await f.report('changes_requested'); await f.engine.tick();
  assert.equal(f.latest().options.sessionId, session);
  f.pr.headSha = revision; await f.report('implementation_ready'); await f.engine.tick();
  f.pr.checks = 'pending'; await f.report('review_passed');
  assert.equal(f.engine.getRun(1).phase, 'reviewing');
  assert.equal(f.publishes, 0);
  const count = f.agents.length;
  await f.engine.tick(); assert.equal(f.agents.length, count);
  f.pr.checks = 'passed'; await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'ready_to_merge');
});

test('stale reviewer result cannot publish a newer revision', async t => {
  const f = await fixture(t);
  await f.engine.start(1, { mode: 'unsupervised' }); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.tick(); f.pr.headSha = implementation; await f.report('implementation_ready'); await f.engine.tick();
  f.pr.headSha = revision; await f.report('review_passed');
  assert.equal(f.publishes, 0);
  assert.match(f.engine.getRun(1).error!, /changed during review/);
});

test('queue dependency readiness, bounded concurrency, and idempotent registration', async t => {
  const f = await fixture(t, { concurrency: 1 });
  f.setReady(false); await f.engine.start(1); await f.engine.tick();
  assert.equal(f.agents.length, 0);
  await f.engine.start(1); assert.equal(f.engine.runs().length, 1);
  await assert.rejects(f.engine.start(1, { mode: 'unsupervised' }), /different workflow/);
  f.setReady(true); await f.engine.start(2); await f.engine.tick();
  assert.equal(f.agents.length, 1);
  await f.engine.pause(1); await f.engine.tick();
  assert.equal(f.agents.length, 2);
  assert.equal(f.latest().options.sessionId, 'gho-2-implementer');
});

test('pause survives restart, messages do not unpause, and closure stops work', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.engine.pause(1);
  assert.equal(f.latest().closed, true);
  await f.restart(); await f.engine.message(1, 'implementer', 'Use this new context'); await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'paused');
  await f.engine.resume(1); await f.engine.tick();
  f.setClosed(); await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'done');
  assert.equal(f.latest().closed, true);
});

test('dialogs are exposed and require an explicit matching response', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick();
  f.latest().emit({ type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: 'Allow?' });
  const view = await f.engine.agent(1, 'implementer') as { status: string; dialogs: unknown[]; messages: unknown[] };
  assert.equal(view.status, 'prompting'); assert.equal(view.dialogs.length, 1); assert.ok(view.messages.length >= 1);
  await assert.rejects(f.engine.respond(1, 'reviewer', { id: 'dialog-1' }), /no longer active/);
  await f.engine.respond(1, 'implementer', { id: 'dialog-1', confirmed: false });
  assert.equal((await f.engine.agent(1, 'implementer') as typeof view).dialogs.length, 0);
});

test('single service ownership rejects concurrent session writers', async t => {
  const f = await fixture(t);
  const release = await acquireLock(f.store.root);
  await assert.rejects(acquireLock(f.store.root), /already running/);
  await release();
  const next = await acquireLock(f.store.root); await next();
});

test('failed approval persistence fails closed and never authorizes implementation', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.report('skeleton_ready');
  const saved = f.store.save.bind(f.store);
  f.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(f.engine.approve(1, skeleton), /persistence failed/);
  assert.equal(f.engine.getRun(1).phase, 'awaiting_approval');
  assert.equal(f.engine.getRun(1).approvedSha, undefined);
  await assert.rejects(f.engine.tick(), /persistence failed/);
  assert.equal(f.agents.length, 1);
  f.store.save = saved;
});

test('a revision changed after approval cannot start its first implementation turn', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.approve(1, skeleton);
  f.pr.headSha = revision;
  await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'planning');
  assert.equal(f.engine.getRun(1).approvedSha, undefined);
  assert.equal(f.agents.length, 1);
});

test('human feedback arriving while waiting for CI returns to implementation before publication', async t => {
  const f = await fixture(t);
  await f.engine.start(1, { mode: 'unsupervised' }); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.tick(); f.pr.headSha = implementation; await f.report('implementation_ready'); await f.engine.tick();
  f.pr.checks = 'pending'; await f.report('review_passed');
  f.pr.feedback.push({ id: 'human-1', author: 'owner', body: 'Fix the authorization check', submittedAt: new Date().toISOString() });
  f.pr.checks = 'passed'; await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'implementing');
  assert.equal(f.publishes, 0);
  assert.match(f.latest().prompts[0]!, /Fix the authorization check/);
});

test('accepted but unconsumed live nudges survive restart and are acknowledged from saved context', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick();
  await f.engine.message(1, 'implementer', 'Preserve the old public interface');
  const message = f.engine.getRun(1).pendingMessages![0]!;
  assert.match(f.latest().nudges[0]!, /Preserve the old/);
  await f.restart(); await f.engine.tick();
  assert.match(f.latest().prompts[0]!, /Preserve the old public interface/);
  assert.ok(f.latest().prompts[0]!.includes(message.marker));
  await f.report('skeleton_ready');
  assert.equal(f.engine.getRun(1).pendingMessages!.length, 0);
});

test('consumed live nudges are not repeated when recovering an interrupted phase', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick();
  await f.engine.message(1, 'implementer', 'Already consumed instruction');
  f.latest().history.push({ role: 'user', content: f.latest().nudges[0]! });
  await f.restart(); await f.engine.tick();
  assert.doesNotMatch(f.latest().prompts[0]!, /Already consumed instruction/);
  assert.equal(f.engine.getRun(1).pendingMessages!.length, 0);
});

test('dialog settling has its own persisted generation independent of other agent activity', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick();
  f.latest().emit({ type: 'extension_ui_request', id: 'first', method: 'confirm' });
  await f.engine.flush();
  const first = f.engine.getRun(1).agents.implementer.settlement;
  assert.ok(first);
  await f.engine.respond(1, 'implementer', { id: 'first', confirmed: false });
  f.latest().emit({ type: 'extension_ui_request', id: 'second', method: 'confirm' });
  await f.engine.flush();
  assert.notEqual(f.engine.getRun(1).agents.implementer.settlement, first);
});

test('startup failure does not authorize a changed first implementation revision', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.approve(1, skeleton);
  f.failNextStart(); await f.engine.tick();
  assert.equal(f.engine.getRun(1).implementationStarted, false);
  assert.equal(f.latest().prompts.length, 0);
  f.pr.headSha = revision;
  await f.engine.pause(1); await f.engine.resume(1); await f.engine.tick();
  assert.equal(f.latest().prompts.length, 0);
  assert.equal(f.engine.getRun(1).phase, 'planning');
});

test('lost prompt acknowledgement recovers admitted implementation from durable conversation evidence', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.approve(1, skeleton);
  f.loseNextAcceptance(); await f.engine.tick();
  assert.equal(f.engine.getRun(1).implementationStarted, false);
  f.pr.headSha = implementation;
  await f.engine.pause(1); await f.engine.resume(1); await f.engine.tick();
  assert.equal(f.engine.getRun(1).phase, 'implementing');
  assert.equal(f.engine.getRun(1).implementationStarted, true);
  assert.match(f.latest().prompts[0]!, /interrupted/);
});

test('nudging a paused approval gate resumes planning and invalidates the old approval target', async t => {
  const f = await fixture(t);
  await f.engine.start(1); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.pause(1); await f.engine.message(1, 'implementer', 'Revise the skeleton before approval');
  await f.engine.resume(1);
  assert.equal(f.engine.getRun(1).phase, 'planning');
  assert.equal(f.engine.getRun(1).skeletonSha, undefined);
  await assert.rejects(f.engine.approve(1, skeleton), /not waiting/);
  await f.engine.tick();
  assert.match(f.latest().prompts[0]!, /Revise the skeleton/);
});

test('nudging a paused published task resumes implementation and re-drafts the PR', async t => {
  const f = await fixture(t);
  await f.engine.start(1, { mode: 'unsupervised' }); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.tick(); f.pr.headSha = implementation; await f.report('implementation_ready'); await f.engine.tick(); await f.report('review_passed');
  assert.equal(f.pr.draft, false);
  await f.engine.pause(1); await f.engine.message(1, 'implementer', 'Fix one more edge case'); await f.engine.resume(1);
  assert.equal(f.engine.getRun(1).phase, 'implementing');
  assert.equal(f.engine.getRun(1).reviewedSha, undefined);
  assert.equal(f.pr.draft, true);
});

test('input-hook dialogs can be answered while prompt acceptance holds the lifecycle queue', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  await f.engine.start(1); f.holdNextPrompt();
  const ticking = f.engine.tick();
  while (!f.agents.length || !(await f.engine.agent(1, 'implementer') as { dialogs: unknown[] }).dialogs.length) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.engine.runs()[0]!.agents.implementer.status, 'prompting');
  assert.ok(f.engine.runs()[0]!.agents.implementer.settlement);
  await f.engine.respond(1, 'implementer', { id: 'input-hook', confirmed: true });
  await ticking;
  assert.equal(f.latest().prompts.length, 1);
});

test('pause and shutdown can interrupt unanswered input hooks without deadlocking', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  await f.engine.start(1); f.holdNextPrompt();
  const ticking = f.engine.tick();
  while (!f.agents.length || !(await f.engine.agent(1, 'implementer') as { dialogs: unknown[] }).dialogs.length) await new Promise(resolve => setTimeout(resolve, 5));
  await f.engine.pause(1); await ticking;
  assert.equal(f.engine.getRun(1).phase, 'paused');
  f.holdNextPrompt(); await f.engine.resume(1);
  const continuing = f.engine.tick();
  while (f.agents.length < 2 || !(await f.engine.agent(1, 'implementer') as { dialogs: unknown[] }).dialogs.length) await new Promise(resolve => setTimeout(resolve, 5));
  await f.engine.close(); await continuing;
  assert.equal(f.latest().closed, true);
});

test('shutdown during provisioning cannot launch a new agent after the shutdown snapshot', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  await f.engine.start(1);
  const create = f.core.createWorktree.bind(f.core);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.core.createWorktree = async issue => { entered(); await held; return create(issue); };
  const ticking = f.engine.tick(); await started;
  const closing = f.engine.close(); release();
  await Promise.all([ticking, closing]);
  assert.equal(f.agents.length, 0);
});

test('pause intent during provisioning prevents dispatch until explicitly resumed', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  await f.engine.start(1);
  const create = f.core.createWorktree.bind(f.core);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.core.createWorktree = async issue => { entered(); await held; return create(issue); };
  const ticking = f.engine.tick(); await started;
  const pausing = f.engine.pause(1); release();
  await Promise.all([ticking, pausing]);
  assert.equal(f.agents.length, 0);
  assert.equal(f.engine.getRun(1).phase, 'paused');
  await f.engine.resume(1); await f.engine.tick();
  assert.equal(f.agents.length, 1);
});

test('failed re-draft leaves a paused published task retryable without changing live state', async t => {
  const f = await fixture(t);
  await f.engine.start(1, { mode: 'unsupervised' }); await f.engine.tick(); await f.report('skeleton_ready');
  await f.engine.tick(); f.pr.headSha = implementation; await f.report('implementation_ready'); await f.engine.tick(); await f.report('review_passed');
  await f.engine.pause(1); await f.engine.message(1, 'implementer', 'Additional correction');
  const draft = f.core.draftPullRequest!.bind(f.core);
  f.core.draftPullRequest = async () => { throw new Error('GitHub unavailable'); };
  await assert.rejects(f.engine.resume(1), /GitHub unavailable/);
  assert.equal(f.engine.getRun(1).phase, 'paused');
  f.core.draftPullRequest = draft;
  await f.engine.resume(1);
  assert.equal(f.engine.getRun(1).phase, 'implementing');
});
