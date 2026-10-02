import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Orchestrator } from '../orchestrator/engine.js';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { DurableAgent, type DurableRuntime } from '../orchestrator/agents/durable/index.js';
import { PiAgent } from '../orchestrator/agents/rpc/index.js';
import { RunStore, atomicJson } from '../orchestrator/store.js';
import { startServer, type DashboardServer, type ServiceAPI } from '../orchestrator/http.js';
import { SystemRunner, type Runner } from '../orchestrator/core/process.js';
import { Workspace } from '../orchestrator/core/workspace.js';
import type { Config } from '../orchestrator/core/types.js';
import type { ExecutionCore, PullRequestInfo, Run, TaskInfo } from '../orchestrator/types.js';

const executable = fileURLToPath(new URL('../../tests/fixtures/workflow-pi.mjs', import.meta.url));
const durableStep = fileURLToPath(new URL('../../tests/fixtures/durable-workflow-step.mjs', import.meta.url));

/**
 * A faux model that works like a disciplined worker: it runs the fixture step through the real durable bash tool,
 * retries the step after an interrupted call, then reports. No model provider or GitHub command is contacted.
 */
function durableRuntime(): DurableRuntime & { requests: () => number } {
  const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'planner' }, { id: 'coder' }, { id: 'reviewer' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const respond: FauxResponseFactory = context => {
    const messages = context.messages;
    const text = (message: (typeof messages)[number]) => JSON.stringify(message.content);
    const promptIndex = messages.findLastIndex(message => message.role === 'user' && text(message).includes('Task and execution data:'));
    const prompt = messages[promptIndex]!.content;
    const promptText = typeof prompt === 'string' ? prompt : prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    const phase = JSON.parse(promptText.slice(promptText.indexOf('{'))) as { phase: string; phaseToken: string };
    const after = messages.slice(promptIndex + 1);
    const stepDone = after.some(message => message.role === 'toolResult' && message.toolName === 'bash' && !message.isError);
    if (!stepDone) {
      const argument = Buffer.from(JSON.stringify(phase)).toString('base64url');
      return fauxAssistantMessage([fauxToolCall('bash', { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(durableStep)} ${argument}` })], { stopReason: 'toolUse' });
    }
    const kind = phase.phase === 'planning' ? 'skeleton_ready' : phase.phase === 'implementing' ? 'implementation_ready' : 'review_passed';
    return fauxAssistantMessage([fauxText(`Reporting ${kind}.`), fauxToolCall('gho_report', { kind, summary: `${phase.phase}: fixture step verified` })], { stopReason: 'toolUse' });
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  return {
    models, settings: { retry: { enabled: false } },
    async resolveModel(pattern) {
      const id = (pattern ?? 'fixture/planner').split('/')[1]!;
      return { model: { provider: 'fixture', modelId: id }, thinkingLevel: 'off' };
    },
    async resources() { return { sections: { preamble: 'Fixture durable worker.' } }; },
    requests: () => faux.state.callCount,
  };
}
const system = new SystemRunner();
interface FixtureState {
  fixture: 'gho-workflow-test'; issue: number; checks: PullRequestInfo['checks'];
  holdPhases: string[]; requestChangesOnce: boolean; pr: PullRequestInfo | null;
  commitTokens: string[]; planningCommits: number; implementationCommits: number;
  reviewTokens: Array<{ token: string; kind: string; sha: string }>;
  contexts: Array<{ phase: string; token: string; sessionId: string; model: string; feedback?: string; approvedSha?: string; reviewTargetSha?: string }>;
  nudges: string[]; mutations: Array<{ kind: 'publish' | 'draft'; number: number; sha: string }>;
  taskState: TaskInfo['state']; completed: boolean;
}
interface Launch { sessionId: string; role: string; model: string; phaseToken: string; pid: number; previousMessages: number }
async function git(checkout: string, args: string[]): Promise<string> {
  return (await system.run({ argv: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], cwd: checkout, timeoutMs: 10_000 })).trim();
}

/** Only the external GitHub adapter is fake. Worktrees, commits, clean-tree checks and journals are real. */
class FileExecutionCore implements ExecutionCore {
  readonly config: Config;
  readonly workspace: Workspace;
  constructor(checkout: string, readonly issue: number, private readonly settings: { holdPhases?: string[]; requestChangesOnce?: boolean; checks?: PullRequestInfo['checks'] }) {
    this.config = { checkout, repo: 'fixture/repo', owner: 'fixture', project_url: 'https://github.com/users/fixture/projects/1', base_branch: 'main', vault: null,
      agents: { planner_model: 'fixture/planner', implementer_model: 'fixture/coder', reviewer_model: 'fixture/reviewer' } };
    const runner: Runner = { run: async command => {
      if (command.argv[0] !== 'wt') return system.run(command);
      const branch = command.argv[command.argv.indexOf('--create') + 1]!, commit = command.argv[command.argv.indexOf('--base') + 1]!;
      return git(checkout, ['worktree', 'add', '-b', branch, this.worktree(), commit]);
    } };
    this.workspace = new Workspace(this.config, runner);
  }
  worktree(): string { return join(dirname(this.config.checkout), `issue-${this.issue}`); }
  statePath(): string { return join(this.worktree(), '.gho', 'workflow.json'); }
  async state(): Promise<FixtureState> { return JSON.parse(await readFile(this.statePath(), 'utf8')) as FixtureState; }
  async update(action: (state: FixtureState) => void): Promise<void> { const state = await this.state(); action(state); await atomicJson(this.statePath(), state); }
  async ready() { const trees = await this.workspace.worktrees(); const branch = `fixture/gh-${this.issue}`; return [{ number: this.issue, state: trees.has(branch) ? 'in_progress' : 'ready', branch, worktree: trees.get(branch) ?? null }]; }
  async snapshot() { return { repo: this.config.repo, project_url: this.config.project_url, workstreams: [], tasks: [{ number: this.issue, title: 'Vertical workflow test' }] }; }
  async createWorktree(issue: number) {
    assert.equal(issue, this.issue);
    const created = await this.workspace.create(issue, 'main'); await this.workspace.writeBrief(created, 'Vertical workflow test');
    const fixture: FixtureState = { fixture: 'gho-workflow-test', issue, checks: this.settings.checks ?? 'passed', holdPhases: this.settings.holdPhases ?? [], requestChangesOnce: this.settings.requestChangesOnce ?? false,
      pr: null, commitTokens: [], planningCommits: 0, implementationCommits: 0, reviewTokens: [], contexts: [], nudges: [], mutations: [], taskState: 'OPEN', completed: false };
    await atomicJson(this.statePath(), fixture); return created;
  }
  async recoverWorktree(issue: number) { assert.equal(issue, this.issue); return this.workspace.recover(issue, 'Vertical workflow test'); }
  async inspectTask(number: number): Promise<TaskInfo> {
    assert.equal(number, this.issue);
    let state: FixtureState | undefined;
    try { state = await this.state(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { number, title: 'Vertical workflow test', body: 'Exercise a committed skeleton, implementation, and independent review.', state: state?.taskState ?? 'OPEN', completed: state?.completed ?? false };
  }
  async inspectPullRequest(issue: number): Promise<PullRequestInfo | null> { assert.equal(issue, this.issue); const state = await this.state(); return state.pr ? { ...state.pr, checks: state.checks } : null; }
  async publishPullRequest(number: number): Promise<void> { await this.update(state => { assert.equal(state.pr?.number, number); assert.equal(state.pr?.state, 'OPEN'); state.pr!.draft = false; state.mutations.push({ kind: 'publish', number, sha: state.pr!.headSha }); }); }
  async draftPullRequest(number: number): Promise<void> { await this.update(state => { assert.equal(state.pr?.number, number); state.pr!.draft = true; state.mutations.push({ kind: 'draft', number, sha: state.pr!.headSha }); }); }
}

async function until<T>(description: string, action: () => Promise<T | false>, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await action(); if (result !== false) return result; await delay(20); }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function jsonLines<T>(path: string): Promise<T[]> {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function fixture(t: { after(fn: () => Promise<void>): void }, settings: { holdPhases?: string[]; requestChangesOnce?: boolean; checks?: PullRequestInfo['checks']; durable?: DurableRuntime } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gho-workflow-integration-')), checkout = join(root, 'repo'); await mkdir(checkout);
  await git(checkout, ['init', '-b', 'main']); await writeFile(join(checkout, 'README.md'), '# Temporary integration repository\n'); await git(checkout, ['add', 'README.md']);
  await git(checkout, ['-c', 'user.name=Workflow Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial fixture']);
  const initialSha = await git(checkout, ['rev-parse', 'HEAD']), issue = 42, storeRoot = join(checkout, '.git', 'gho-service');
  const errors: string[] = [];
  let core = new FileExecutionCore(checkout, issue, settings), store = new RunStore(storeRoot), engine: Orchestrator, server: DashboardServer;
  const start = async () => {
    const runtime = settings.durable;
    engine = new Orchestrator(core, store, options => runtime ? new DurableAgent({ ...options, runtime })
      : new PiAgent({ ...options, command: process.execPath, args: [executable], startupTimeoutMs: 5_000, commandTimeoutMs: 5_000, shutdownTimeoutMs: 500 }),
      { concurrency: 1, pollMs: 100, runTimeoutMs: 15_000, maxReviewRounds: 3, onError: error => errors.push(String(error)) });
    await engine.initialize();
    const api: ServiceAPI = {
      snapshot: () => engine.snapshot(), runs: () => engine.runs(), getRun: value => engine.getRun(value), start: (value, options) => engine.start(value, options),
      approve: (value, sha, actor) => engine.approve(value, sha, actor ?? 'dashboard', 'dashboard'), pause: value => engine.pause(value), resume: value => engine.resume(value),
      message: (value, role, text) => engine.message(value, role, text), agent: (value, role) => engine.agent(value, role), respond: (value, role, response) => engine.respond(value, role, response),
    };
    server = await startServer(api, { requestTimeoutMs: 10_000 }); engine.begin();
  };
  t.after(async () => {
    try { await server?.close(); await engine?.close(); }
    finally {
      await writeFile(join(core.worktree(), '.gho', 'step-release'), '').catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
  await start();
  async function request<T>(path: string, body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { 'x-gho-token': server.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000) });
    const result = await response.json() as T; assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result;
  }
  const run = () => request<Run>(`/api/runs/${issue}`);
  const waitRun = (description: string, predicate: (run: Run) => boolean) => until(description, async () => { const current = await run(); assert.notEqual(current.phase, 'blocked', JSON.stringify(current)); assert.equal(current.error, undefined, JSON.stringify(current)); return predicate(current) ? current : false; });
  return {
    issue, initialSha, checkout, errors, request, run, waitRun,
    get core() { return core; }, get store() { return store; }, get engine() { return engine; },
    launches: () => jsonLines<Launch>(join(core.worktree(), '.gho', 'workflow-launches.jsonl')),
    async restart() { await server.close(); await engine.close(); core = new FileExecutionCore(checkout, issue, settings); store = new RunStore(storeRoot); await start(); },
  };
}

test('HTTP → engine → persistent Pi RPC: supervised revision gates, nudges, restart, review fixes and publish-only', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { holdPhases: ['planning'], requestChangesOnce: true, checks: 'pending' });
  const startPath = `/api/runs/${f.issue}`;
  await f.request(`${startPath}/start`, { mode: 'supervised' });
  const original = await f.waitRun('real planner subprocess', current => current.phase === 'planning' && current.agents.implementer.status === 'working');
  await until('first committed skeleton', async () => (await f.core.state()).planningCommits === 1);
  const firstToken = original.dispatch!.id, firstSha = (await f.core.state()).pr!.headSha;
  assert.notEqual(firstSha, f.initialSha); assert.equal(await git(f.core.worktree(), ['status', '--porcelain']), '');
  await until('intermediate agent_end journaled without a report', async () => {
    const agent = await f.request<{ events: Array<{ type: string; willRetry?: boolean }> }>(`${startPath}/agents/implementer`);
    return agent.events.some(event => event.type === 'agent_end' && event.willRetry === true);
  });
  await assert.rejects(readFile(original.dispatch!.reportPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  await f.engine.flush(); assert.equal((await f.run()).phase, 'planning'); // agent_end is not agent_settled.
  const beforeRestart = await f.launches(); assert.equal(beforeRestart.length, 1);
  await f.restart();
  await until('same planner thread resumed', async () => (await f.launches()).length === 2);
  await f.waitRun('recovered planner running', current => current.phase === 'planning' && current.agents.implementer.status === 'working');
  const recoveredLaunch = (await f.launches())[1]!;
  assert.equal(recoveredLaunch.sessionId, beforeRestart[0]!.sessionId); assert.notEqual(recoveredLaunch.pid, beforeRestart[0]!.pid); assert.equal(recoveredLaunch.phaseToken, firstToken); assert.ok(recoveredLaunch.previousMessages > 0);
  assert.equal((await f.core.state()).planningCommits, 1, 'recovery must not repeat the committed side effect');
  await f.request(`${startPath}/agents/implementer/messages`, { text: 'Remember the boundary test.' });
  let awaiting = await f.waitRun('supervised approval gate', current => current.phase === 'awaiting_approval');
  assert.equal(awaiting.skeletonSha, firstSha); assert.equal(awaiting.approvedSha, undefined); assert.equal((await f.core.state()).implementationCommits, 0);
  const nudges = (await f.core.state()).nudges; assert.equal(nudges.length, 1); assert.match(nudges[0]!, /Remember the boundary test\.$/);
  const transcript = await f.request<{ messages: unknown[]; events: Array<{ type: string; text?: string }> }>(`${startPath}/agents/implementer`);
  assert.match(JSON.stringify(transcript.messages), /Remember the boundary test/); assert.ok(transcript.events.some(event => event.type === 'operator_message_accepted'));
  await f.request(`${startPath}/approve`, { sha: firstSha.slice(0, 8) }, 400);
  await f.request(`${startPath}/approve`, { sha: 'f'.repeat(40) }, 409);
  assert.equal((await f.run()).phase, 'awaiting_approval');
  await f.request(`${startPath}/agents/implementer/messages`, { text: 'Revise the skeleton to handle empty input.' });
  awaiting = await f.waitRun('revised skeleton approval gate', current => current.phase === 'awaiting_approval' && current.skeletonSha !== firstSha);
  assert.equal((await f.core.state()).planningCommits, 2); assert.equal((await f.core.state()).implementationCommits, 0);
  assert.match(await readFile(join(f.core.worktree(), 'skeleton.md'), 'utf8'), /Revise the skeleton to handle empty input/);
  await f.request(`${startPath}/approve`, { sha: firstSha }, 409);
  const revisedSha = awaiting.skeletonSha!, countAtGate = (await f.launches()).length;
  await f.restart(); await f.engine.tick();
  assert.equal((await f.run()).skeletonSha, revisedSha); assert.equal((await f.launches()).length, countAtGate, 'restart cannot bypass the human gate');
  const approval = await f.request<Run>(`${startPath}/approve`, { sha: revisedSha, actor: 'integration-reviewer' });
  assert.equal(approval.approval?.sha, revisedSha); assert.equal(approval.approval?.source, 'dashboard'); assert.equal(approval.approval?.actor, 'integration-reviewer');
  const reviewed = await f.waitRun('independent review passes; CI still pending', current => current.phase === 'reviewing' && Boolean(current.reviewedSha));
  let state = await f.core.state();
  assert.equal(state.implementationCommits, 2); assert.deepEqual(state.reviewTokens.map(review => review.kind), ['changes_requested', 'review_passed']);
  assert.equal(state.mutations.length, 0); assert.equal(state.pr!.draft, true); assert.equal(reviewed.reviewRounds, 1);
  assert.notEqual(reviewed.reviewedSha, revisedSha); assert.equal(reviewed.reviewedSha, await git(f.core.worktree(), ['rev-parse', 'HEAD']));
  const launches = await f.launches(), implementers = launches.filter(launch => launch.role === 'implementer'), reviewers = launches.filter(launch => launch.role === 'reviewer');
  assert.equal(new Set(implementers.map(launch => launch.sessionId)).size, 1); assert.deepEqual([...new Set(implementers.map(launch => launch.model))], ['fixture/planner', 'fixture/coder']);
  assert.equal(new Set(reviewers.map(launch => launch.sessionId)).size, 1); assert.notEqual(reviewers[0]!.sessionId, implementers[0]!.sessionId);
  assert.ok(implementers.filter(launch => launch.model === 'fixture/coder').every(launch => launch.previousMessages > 0)); assert.ok(reviewers[1]!.previousMessages > 0);
  assert.match(state.contexts.filter(context => context.phase === 'implementing')[1]!.feedback!, /empty-input test/);
  assert.ok(state.contexts.filter(context => context.phase === 'implementing').every(context => context.approvedSha === revisedSha));
  const launchCount = launches.length; await f.restart(); await f.engine.tick(); assert.equal((await f.launches()).length, launchCount, 'pending CI does not rerun the passed review');
  await f.core.update(value => { value.checks = 'passed'; });
  const published = await f.waitRun('PR published without merging', current => current.phase === 'ready_to_merge');
  state = await f.core.state(); assert.equal(state.pr!.state, 'OPEN'); assert.equal(state.pr!.draft, false); assert.deepEqual(state.mutations, [{ kind: 'publish', number: state.pr!.number, sha: published.reviewedSha }]);
  assert.equal(await git(f.checkout, ['rev-parse', 'main']), f.initialSha, 'publishing must never merge the branch');
  assert.equal(await git(f.core.worktree(), ['rev-list', '--count', 'HEAD']), '5');
  const persisted = (await new RunStore(f.store.root).load())[0]!; assert.equal(persisted.phase, 'ready_to_merge'); assert.equal(persisted.agents.implementer.sessionId, implementers[0]!.sessionId);
  const snapshot = await f.request<{ tasks: Array<{ execution: Run }> }>('/api/snapshot'); assert.equal(snapshot.tasks[0]!.execution.reviewedSha, published.reviewedSha);
  assert.equal(f.errors.length, 2); assert.ok(f.errors.every(error => error.includes('Skeleton changed.')), 'only the two deliberate stale approvals should be rejected');
  assert.deepEqual(f.engine.errors, []);
});

test('HTTP unsupervised workflow still records a real skeleton approval and independent review before publishing', { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const path = `/api/runs/${f.issue}`;
  await f.request(`${path}/start`, { mode: 'unsupervised' });
  const run = await f.waitRun('automatic workflow ready for human merge', current => current.phase === 'ready_to_merge');
  const state = await f.core.state(), launches = await f.launches();
  assert.equal(state.planningCommits, 1); assert.equal(state.implementationCommits, 1); assert.equal(state.reviewTokens.length, 1);
  assert.equal(run.approval?.source, 'automatic'); assert.equal(run.approval?.sha, run.skeletonSha); assert.equal(run.approvedSha, run.skeletonSha);
  assert.notEqual(run.skeletonSha, run.reviewedSha); assert.equal(await git(f.core.worktree(), ['rev-parse', 'HEAD^']), run.skeletonSha);
  assert.deepEqual(launches.map(launch => launch.model), ['fixture/planner', 'fixture/coder', 'fixture/reviewer']); assert.equal(launches[0]!.sessionId, launches[1]!.sessionId); assert.ok(launches[1]!.previousMessages > 0);
  assert.equal(state.pr!.state, 'OPEN'); assert.equal(state.pr!.draft, false); assert.equal(state.mutations.filter(mutation => mutation.kind === 'publish').length, 1);
  assert.equal(await git(f.checkout, ['rev-parse', 'main']), f.initialSha);
  await f.restart(); await f.engine.tick(); assert.equal((await f.run()).phase, 'ready_to_merge'); assert.equal((await f.launches()).length, 3);
  const transcript = await f.request<{ messages: unknown[] }>(`${path}/agents/implementer`); assert.match(JSON.stringify(transcript.messages), /implementation_ready/);
  // Only a separately observed external completion ends the run; publishing itself never does.
  await f.core.update(value => { value.taskState = 'CLOSED'; value.completed = true; });
  await f.waitRun('external issue completion', current => current.phase === 'done');
  assert.equal((await f.core.state()).mutations.length, 1); assert.deepEqual(f.errors, []);
});

test('HTTP → engine → Pi Durable: unsupervised workflow through real durable tools, then human-merge gate', { timeout: 30_000 }, async t => {
  const runtime = durableRuntime();
  const f = await fixture(t, { durable: runtime });
  const path = `/api/runs/${f.issue}`;
  await f.request(`${path}/start`, { mode: 'unsupervised' });
  const run = await f.waitRun('automatic workflow ready for human merge', current => current.phase === 'ready_to_merge');
  const state = await f.core.state();
  assert.equal(state.planningCommits, 1); assert.equal(state.implementationCommits, 1);
  assert.equal(run.approval?.source, 'automatic'); assert.equal(run.approvedSha, run.skeletonSha); assert.notEqual(run.skeletonSha, run.reviewedSha);
  assert.deepEqual(state.contexts.map(context => [context.phase, context.model]), [['planning', 'fixture/planner'], ['implementing', 'fixture/coder'], ['reviewing', 'fixture/reviewer']]);
  assert.equal(state.contexts[0]!.sessionId, state.contexts[1]!.sessionId, 'planner and implementer share one durable conversation');
  assert.notEqual(state.contexts[2]!.sessionId, state.contexts[0]!.sessionId);
  assert.equal(state.pr!.draft, false); assert.equal(state.mutations.filter(mutation => mutation.kind === 'publish').length, 1);
  assert.equal(await git(f.checkout, ['rev-parse', 'main']), f.initialSha);
  assert.equal(runtime.requests(), 6, 'one step and one report request per phase; gho_report terminates each run');
  const transcript = await f.request<{ messages: Array<{ role: string }>; events: Array<{ type: string }> }>(`${path}/agents/implementer`);
  assert.match(JSON.stringify(transcript.messages), /implementation_ready/);
  assert.ok(transcript.events.some(event => event.type === 'tool_execution_end'));
  assert.ok(transcript.events.some(event => event.type === 'driver_ready'));
  assert.deepEqual(f.errors, []);
});

test('Pi Durable: a service restart mid-tool resumes the same turn without a new prompt or a repeated commit', { timeout: 30_000 }, async t => {
  const runtime = durableRuntime();
  const f = await fixture(t, { durable: runtime, holdPhases: ['planning'] });
  const path = `/api/runs/${f.issue}`;
  await f.request(`${path}/start`, { mode: 'unsupervised' });
  const holding = join(f.core.worktree(), '.gho', 'step-holding');
  await until('planning step holds inside the bash tool', async () => (await readFile(holding, 'utf8').catch(() => '')) !== '');
  assert.equal((await f.core.state()).planningCommits, 1);
  const token = (await f.run()).dispatch!.id;
  await f.restart();
  const run = await f.waitRun('workflow ready after resumed planning turn', current => current.phase === 'ready_to_merge');
  const state = await f.core.state();
  assert.equal(state.planningCommits, 1, 'recovery must not repeat the committed side effect');
  assert.equal(state.contexts.filter(context => context.phase === 'planning').length, 2, 'the interrupted step was retried by the model');
  assert.equal(run.approvedSha, run.skeletonSha);
  const transcript = await f.request<{ messages: Array<{ role: string; content: unknown; isError?: boolean }> }>(`${path}/agents/implementer`);
  const users = transcript.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content));
  assert.equal(users.filter(text => text.includes(token)).length, 1, 'the resumed turn needs no recovery prompt');
  assert.ok(transcript.messages.some(message => message.role === 'toolResult' && message.isError && JSON.stringify(message.content).includes('interrupted')));
  assert.deepEqual(f.errors, []);
});
