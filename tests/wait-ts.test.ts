import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer, type ServiceAPI } from '../orchestrator/http.js';
import type { ServiceDescriptor } from '../orchestrator/service.js';
import type { AgentRecord, AgentStatus, Run } from '../orchestrator/types.js';
import { observeAgents, parseAgentCursor, parseAgentTargets, stopService, waitForAgents, waitForServiceStop } from '../orchestrator/wait.js';

const exec = promisify(execFile);
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';
const cursor = (value: Record<string, string>) => JSON.stringify(value);
function agent(status: AgentStatus, settlement?: string): AgentRecord {
  return { sessionId: 'saved-session', status, ...(settlement ? { settlement } : {}) };
}
function run(issue: number, implementer = agent('working'), reviewer = agent('idle')): Run {
  return {
    version: 1, issue, repo: 'test/repo', mode: 'supervised', phase: 'planning',
    agents: { implementer, reviewer }, seenFeedback: [], reviewRounds: 0, failures: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

test('agent targets validate exact issue/role syntax and deduplicate deterministically', () => {
  assert.deepEqual(parseAgentTargets(['43/reviewer', '42', '42/implementer', '42']), [{ issue: 42 }, { issue: 42, role: 'implementer' }, { issue: 43, role: 'reviewer' }]);
  for (const bad of ['', '0', '-1', '01', '#42', '42.0', '4e2', ' 42', '42 ', '42/', '/reviewer', '42/planner', '42/Reviewer', '42/reviewer/extra', 'https://github.com/test/repo/issues/42', '9007199254740992']) assert.throws(() => parseAgentTargets([bad]), /Invalid agent target/, bad);
});

test('agent cursors validate their per-role settlement UUID schema', () => {
  assert.equal(parseAgentCursor().size, 0);
  assert.equal(parseAgentCursor('start').size, 0);
  assert.equal(parseAgentCursor('{}').size, 0);
  assert.deepEqual([...parseAgentCursor(cursor({ '42/reviewer': A }))], [['42/reviewer', A]]);
  for (const bad of ['', 'null', '[]', 'true', '42', '"start"', '{', '[[42,"2026-01-01"]]', cursor({ '42': A }), cursor({ '42/planner': A }), cursor({ '42/reviewer': '2026-01-01' }), cursor({ '42/reviewer': '' }), '{"42/reviewer":3}', '{"__proto__":"x"}']) assert.throws(() => parseAgentCursor(bad), /Invalid agent cursor/, bad);
});

test('an exact reviewer target neither wakes on nor returns the implementer', () => {
  const task = run(42, agent('settled', A), agent('working'));
  const waiting = observeAgents([task], { targets: ['42/reviewer'] });
  assert.equal(waiting.settled, false);
  assert.deepEqual(waiting.agents.map(value => [value.id, value.status, value.new]), [['42/reviewer', 'working', false]]);
  task.agents.reviewer = agent('prompting', B);
  const prompted = observeAgents([task], { targets: ['42/reviewer'] });
  assert.equal(prompted.settled, true);
  assert.deepEqual(JSON.parse(prompted.cursor), { '42/reviewer': B });
});

test('issue-only and no-target waits select started roles, not preallocated idle sessions', () => {
  const tasks = [run(42, agent('settled', A)), run(43, agent('starting'), agent('working')), run(44, agent('idle'))];
  assert.deepEqual(observeAgents(tasks).agents.map(value => value.id), ['42/implementer', '43/implementer', '43/reviewer']);
  const selected = observeAgents(tasks, { targets: ['42'], all: true });
  assert.equal(selected.settled, true);
  assert.deepEqual(selected.agents.map(value => value.id), ['42/implementer']);
  assert.equal(observeAgents([run(42, agent('idle'))], { all: true }).settled, false);
  assert.equal(observeAgents([], { all: true }).settled, false);
});

test('--all requires every selected actual agent settled and at least one new settlement', () => {
  const task = run(42, agent('settled', A), agent('working'));
  assert.equal(observeAgents([task]).settled, true);
  const waiting = observeAgents([task], { all: true });
  assert.equal(waiting.settled, false);
  assert.equal(waiting.cursor, 'start', 'Waiting must not consume an early settlement');
  task.agents.reviewer = agent('prompting', B);
  const result = observeAgents([task], { all: true, since: cursor({ '42/implementer': A }) });
  assert.equal(result.settled, true);
  assert.deepEqual(result.agents.map(value => value.new), [false, true]);
  assert.deepEqual(JSON.parse(result.cursor), { '42/implementer': A, '42/reviewer': B });
  assert.equal(observeAgents([task], { all: true, since: result.cursor }).settled, false);
});

test('--all waits for an explicitly named role that has not launched', () => {
  const tasks = [run(42, agent('settled', A))];
  assert.equal(observeAgents(tasks, { targets: ['42/implementer', '42/reviewer'], all: true }).settled, false);
  assert.equal(observeAgents(tasks, { targets: ['42/reviewer'] }).agents.length, 0);
  assert.equal(observeAgents(tasks, { targets: ['42/implementer', '99'], all: true }).settled, false);
  assert.equal(observeAgents(tasks, { targets: ['42/implementer', '99'] }).settled, true);
});

test('run timestamps, phase changes and unrelated agent updates cannot create false wakes', () => {
  const task = run(42, agent('settled', A), agent('prompting', B));
  const options = { targets: ['42/implementer'], since: cursor({ '42/implementer': A }) };
  task.updatedAt = '2026-01-02T00:00:00Z'; task.phase = 'awaiting_approval'; task.feedback = 'changed'; task.agents.implementer.model = 'new-model';
  const observed = observeAgents([task, run(43, agent('settled', C))], options);
  assert.equal(observed.settled, false);
  assert.equal(observed.agents[0]?.new, false);
  assert.equal(observed.cursor, options.since);
  const working = run(42, agent('working', B)); working.phase = 'paused';
  assert.equal(observeAgents([working]).settled, false, 'A run phase is not an agent settlement');
});

test('a new dialog or exit wakes even when the whole-run timestamp is unchanged', () => {
  for (const status of ['prompting', 'settled', 'exited'] as const) {
    const task = run(42, agent(status, B));
    const result = observeAgents([task], { since: cursor({ '42/implementer': A }) });
    assert.equal(result.settled, true, status);
    assert.equal(result.agents[0]?.new, true, status);
    assert.equal(JSON.parse(result.cursor)['42/implementer'], B);
  }
  assert.equal(observeAgents([run(42, agent('settled'))]).settled, false, 'Missing IDs must not fall back to updatedAt');
});

test('cursor identities are role-specific and preserve previously consumed unselected agents', () => {
  const task = run(42, agent('settled', A), agent('settled', A));
  const result = observeAgents([task], { targets: ['42/reviewer'], since: cursor({ '42/implementer': A, '99/reviewer': C }) });
  assert.equal(result.settled, true);
  assert.deepEqual(JSON.parse(result.cursor), { '42/implementer': A, '42/reviewer': A, '99/reviewer': C });
  assert.equal(observeAgents([run(42, agent('working', B))], { since: cursor({ '42/implementer': A }) }).settled, false);
});

test('wait returns per-agent JSON, honors zero timeout, and preserves unconsumed --all events', async () => {
  let calls = 0;
  const result = await waitForAgents(async () => { calls++; return [run(42, agent('settled', A), agent('working'))]; }, { all: true, timeoutMs: 0 });
  assert.equal(calls, 1);
  assert.equal(result.result, 'timeout'); assert.equal(result.cursor, 'start');
  assert.equal(result.agents[0]?.new, true);
  assert.equal(Object.hasOwn(result, 'runs'), false);
  let checks = 0;
  const settled = await waitForAgents(async () => [run(42, agent(++checks === 1 ? 'working' : 'prompting', B))], { intervalMs: 1, timeoutMs: 100 });
  assert.equal(settled.result, 'settled'); assert.equal(checks, 2);
});

test('wait validates inputs before contacting the service and bounds the final sleep', async () => {
  let calls = 0;
  const read = async () => { calls++; return []; };
  for (const options of [{ targets: ['42/no'] }, { since: 'bad' }, { intervalMs: 0 }, { timeoutMs: -1 }]) await assert.rejects(waitForAgents(read, options));
  assert.equal(calls, 0);
  const start = performance.now();
  const result = await waitForAgents(read, { intervalMs: 60_000, timeoutMs: 15 });
  assert.equal(result.result, 'timeout');
  assert(performance.now() - start < 1_000, 'A 15ms timeout must not sleep for a 60s interval');
});

async function ownerFiles(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gho-stop-wait-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected: ServiceDescriptor = { pid: process.pid, port: 12345, token: 'fixture-token', url: 'http://127.0.0.1:12345/', repo: 'test/repo', createdAt: '2026-01-01' };
  const save = async () => {
    await writeFile(join(root, 'service.json'), JSON.stringify(expected));
    await writeFile(join(root, 'service.lock'), JSON.stringify({ pid: expected.pid, nonce: A }));
  };
  const release = async () => { await rm(join(root, 'service.json'), { force: true }); await rm(join(root, 'service.lock'), { force: true }); };
  await save();
  return { root, expected, save, release };
}

test('shutdown completion requires both descriptor and lock release', async t => {
  const files = await ownerFiles(t);
  await rm(join(files.root, 'service.json'));
  await assert.rejects(waitForServiceStop(files.root, files.expected, { timeoutMs: 5, intervalMs: 1 }), /lock remains/);
  assert(existsSync(join(files.root, 'service.lock')));
  await files.save(); await rm(join(files.root, 'service.lock'));
  await assert.rejects(waitForServiceStop(files.root, files.expected, { timeoutMs: 5, intervalMs: 1 }), /descriptor or lock remains/);
  await files.release();
  await waitForServiceStop(files.root, files.expected, { timeoutMs: 0 });
  await waitForServiceStop(files.root, null, { timeoutMs: 0 });
});

test('shutdown refuses descriptor or lock replacement without deleting files or killing a PID', async t => {
  const files = await ownerFiles(t);
  await assert.rejects(waitForServiceStop(files.root, { ...files.expected, token: 'stale-token' }), /ownership changed/);
  await assert.rejects(waitForServiceStop(files.root, { ...files.expected, pid: process.pid + 1 }), /ownership changed/);
  await writeFile(join(files.root, 'service.lock'), JSON.stringify({ pid: process.pid + 1, nonce: A }));
  await assert.rejects(waitForServiceStop(files.root, files.expected), /different process/);
  assert(existsSync(join(files.root, 'service.json')));
  assert(existsSync(join(files.root, 'service.lock')));
  assert.equal(JSON.parse(await readFile(join(files.root, 'service.json'), 'utf8')).token, 'fixture-token');
});

test('missing descriptor with a remaining lock is not reported as already stopped', async t => {
  const files = await ownerFiles(t);
  await rm(join(files.root, 'service.json'));
  await assert.rejects(stopService(files.root, null, { timeoutMs: 5, intervalMs: 1 }), /still stopping/);
  assert(existsSync(join(files.root, 'service.lock')));
});

async function httpFixture(t: TestContext) {
  const files = await ownerFiles(t);
  const calls: string[] = [];
  let shutdown: () => Promise<unknown> = async () => {};
  let runs: Run[] = [];
  const api: ServiceAPI = {
    snapshot: async () => { throw new Error('Wait must not read GitHub.'); },
    runs: () => { calls.push('runs'); return runs; }, getRun: async () => undefined,
    start: async () => { throw new Error('Wait must not start tasks.'); }, approve: async () => ({}), pause: async () => ({}), resume: async () => ({}),
    message: async () => ({}), agent: async () => ({}), respond: async () => ({}), shutdown: async () => { calls.push('shutdown'); return shutdown(); },
  };
  const server = await startServer(api); t.after(() => server.close());
  Object.assign(files.expected, { port: server.port, token: server.token, url: server.url });
  await files.save();
  return { ...files, server, calls, setRuns(value: Run[]) { runs = value; }, setShutdown(value: () => Promise<unknown>) { shutdown = value; } };
}

test('authenticated shutdown waits for delayed engine cleanup and final lock release', async t => {
  const fixture = await httpFixture(t);
  let released = false;
  fixture.setShutdown(async () => {
    await delay(25); await fixture.server.close();
    await rm(join(fixture.root, 'service.json'));
    await delay(25); await rm(join(fixture.root, 'service.lock')); released = true;
  });
  await stopService(fixture.root, fixture.expected, { timeoutMs: 2_000, intervalMs: 1 });
  assert.equal(released, true);
  assert.deepEqual(fixture.calls, ['shutdown']);
});

test('health failure does not short-circuit the remaining ownership-file wait', async t => {
  const fixture = await httpFixture(t);
  await fixture.server.close();
  await assert.rejects(stopService(fixture.root, fixture.expected, { timeoutMs: 15, intervalMs: 1 }), /still stopping/);
  assert(existsSync(join(fixture.root, 'service.lock')));
  const release = delay(20).then(() => fixture.release());
  await stopService(fixture.root, fixture.expected, { timeoutMs: 2_000, intervalMs: 1 });
  await release;
  assert.deepEqual(fixture.calls, []);
});

test('actual CLI preserves /reviewer targets and waits for shutdown files after HTTP closes', async t => {
  const fixture = await httpFixture(t);
  const repo = join(fixture.root, 'repo'), config = join(fixture.root, 'config');
  await mkdir(repo); await mkdir(join(config, 'repos/test'), { recursive: true });
  const env = { ...process.env, GHO_CONFIG_DIR: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/test/repo.git'], { cwd: repo, env });
  await writeFile(join(config, 'config.toml'), 'owner = "test"\n');
  await writeFile(join(config, 'repos/test/repo.toml'), 'project_url = "https://github.com/users/test/projects/1"\nbase_branch = "main"\n');
  const runtime = join(repo, '.git', 'gho-service'); await mkdir(runtime);
  await writeFile(join(runtime, 'service.json'), JSON.stringify(fixture.expected));
  await writeFile(join(runtime, 'service.lock'), JSON.stringify({ pid: process.pid, nonce: A }));
  const root = new URL(existsSync(new URL('../package.json', import.meta.url)) ? '../' : '../../', import.meta.url);
  const cli = (...args: string[]) => exec(process.execPath, [fileURLToPath(new URL('bin/gho.mjs', root)), ...args], { cwd: repo, env, timeout: 5_000 });
  fixture.setRuns([run(42, agent('settled', A), agent('working'))]);
  const waiting = JSON.parse((await cli('wait', 'agents', '42/reviewer', '--timeout', '0')).stdout);
  assert.equal(waiting.result, 'timeout');
  assert.deepEqual(waiting.agents.map((value: { id: string }) => value.id), ['42/reviewer']);
  fixture.setRuns([run(42, agent('settled', A), agent('prompting', B))]);
  const result = JSON.parse((await cli('wait', 'agents', '42/reviewer', '--timeout', '0')).stdout);
  assert.equal(result.result, 'settled'); assert.equal(result.agents[0].new, true);
  const repeated = JSON.parse((await cli('wait', 'agents', '42/reviewer', '--timeout', '0', '--since', result.cursor)).stdout);
  assert.equal(repeated.result, 'timeout'); assert.equal(repeated.agents[0].new, false);
  await assert.rejects(cli('wait', 'agents', '42/not-a-role', '--timeout', '0'), /Invalid agent target/);
  let released = false;
  fixture.setShutdown(async () => {
    await fixture.server.close(); await delay(50); await rm(join(runtime, 'service.json'));
    await delay(50); await rm(join(runtime, 'service.lock')); released = true;
  });
  assert.deepEqual(JSON.parse((await cli('service', 'stop')).stdout), { stopped: true });
  assert.equal(released, true);
  assert.equal(existsSync(join(runtime, 'service.json')), false); assert.equal(existsSync(join(runtime, 'service.lock')), false);
});
