import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { DurableAgent, type DurableRuntime } from '../orchestrator/agents/durable/index.js';
import type { AgentOptions } from '../orchestrator/agents/types.js';

type Event = Record<string, unknown>;
type Context = Parameters<Extract<FauxResponseStep, (...args: never[]) => unknown>>[0];

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'gho-durable-'));
  const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'planner' }, { id: 'coder' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: Context[] = [];
  const resolved: Array<string | undefined> = [];
  const runtime: DurableRuntime = {
    models, settings: { retry: { enabled: false } },
    async resolveModel(pattern) {
      resolved.push(pattern);
      if (pattern === 'fixture/missing') return undefined;
      return { model: { provider: 'fixture', modelId: (pattern ?? 'fixture/planner').split('/')[1]! }, thinkingLevel: 'low' };
    },
    async resources() { return { sections: { preamble: 'Fixture preamble from Pi.', project_context: '<project_context>\nFixture AGENTS.md\n</project_context>' } }; },
  };
  const instructionsPath = join(root, 'worker.md');
  await writeFile(instructionsPath, '<!-- Purpose: test. -->\nFixture worker instructions.\n');
  const agents: DurableAgent[] = [];
  const options = (overrides: Partial<AgentOptions> = {}): AgentOptions => ({
    cwd: root, sessionId: 'gho-7-implementer', sessionDir: join(root, '.gho', 'sessions'), role: 'implementer',
    instructionsPath, reportPath: join(root, '.gho', 'reports', 'token-1.json'), phaseToken: 'token-1', ...overrides,
  });
  const open = async (overrides: Partial<AgentOptions> = {}) => {
    const events: Event[] = [];
    const agent = new DurableAgent({ ...options(overrides), runtime });
    agent.onEvent(event => events.push(event));
    agents.push(agent);
    await agent.start();
    return { agent, events };
  };
  const respond = (...steps: Array<(context: Context) => ReturnType<typeof fauxAssistantMessage>>) =>
    faux.setResponses(steps.map(step => (context: Context) => { requests.push(context); return step(context); }));
  t.after(async () => {
    await Promise.allSettled(agents.map(agent => agent.close()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, faux, requests, resolved, open, respond, options, runtime };
}
async function until(description: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 10)); }
  throw new Error(`Timed out waiting for ${description}`);
}
const settled = (events: Event[]) => events.filter(event => event.type === 'agent_settled').length;
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => () => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

test('a phase runs Pi prompt sections and instructions, real tools, and a terminating report', async t => {
  const s = await setup(t);
  s.respond(call('bash', { command: 'printf "%s|%s|%s|%s" "$PI_SESSION_ID" "$PI_PROVIDER/$PI_MODEL" "${PI_SESSION_FILE:-unset}" "$PI_REASONING_LEVEL"' }),
    call('gho_report', { kind: 'skeleton_ready', summary: 'Skeleton pushed.' }),
    () => fauxAssistantMessage([fauxText('This response must never be requested.')]));
  process.env.PI_SESSION_FILE = '/supervisor/session.jsonl';
  t.after(() => { delete process.env.PI_SESSION_FILE; });
  const { agent, events } = await s.open({ model: 'fixture/planner' });
  assert.equal(agent.resumedWork, false);
  const ready = events.find(event => event.type === 'driver_ready') as { state: { model: { provider: string; id: string }; thinkingLevel: string } };
  assert.deepEqual(ready.state.model, { provider: 'fixture', id: 'planner' }); assert.equal(ready.state.thinkingLevel, 'low');
  assert.deepEqual(await agent.prompt('Plan the task. phase token-1'), { disposition: 'started' });
  await until('settlement', () => settled(events) === 1);
  assert.deepEqual(JSON.parse(await readFile(join(s.root, '.gho', 'reports', 'token-1.json'), 'utf8')), { phaseToken: 'token-1', kind: 'skeleton_ready', summary: 'Skeleton pushed.' });
  assert.equal(s.requests.length, 2, 'gho_report terminates the run');
  const system = JSON.stringify(s.requests[0]!.messages.filter(message => message.role === 'system'));
  for (const expected of ['Fixture preamble from Pi.', 'Fixture AGENTS.md', 'Fixture worker instructions.']) assert.ok(system.includes(expected), expected);
  assert.ok(!system.includes('Purpose: test'), 'resource header comments are not model input');
  const messages = await agent.getMessages() as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'toolResult', 'assistant', 'toolResult']);
  assert.equal(JSON.stringify(messages[2]!.content).includes('gho-7-implementer|fixture/planner|unset|low'), true, JSON.stringify(messages[2]));
  const types = events.map(event => event.type);
  for (const expected of ['agent_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'agent_end', 'agent_settled']) assert.ok(types.includes(expected), expected);
  assert.ok(types.indexOf('agent_end') < types.indexOf('agent_settled'));
  assert.throws(() => agent.respond(), /no|not/i);
});

test('the shared conversation keeps its model unless a pattern changes it, and a repeated prompt is delivered once', async t => {
  const s = await setup(t);
  s.respond(() => fauxAssistantMessage([fauxText('planned')]), () => fauxAssistantMessage([fauxText('implemented')]));
  let { agent, events } = await s.open({ model: 'fixture/planner' });
  await agent.prompt('Plan.'); await until('planning settled', () => settled(events) === 1);
  await agent.prompt('Plan.'); await until('repeat settled', () => settled(events) === 2);
  assert.equal((await agent.getMessages() as Array<{ role: string }>).filter(message => message.role === 'user').length, 1);
  await agent.close();
  ({ agent, events } = await s.open());
  assert.deepEqual((await agent.getState()).model, { provider: 'fixture', id: 'planner' }, 'absent pattern keeps the saved model');
  await agent.close();
  ({ agent, events } = await s.open({ model: 'fixture/coder', phaseToken: 'token-2' }));
  assert.deepEqual((await agent.getState()).model, { provider: 'fixture', id: 'coder' });
  await agent.prompt('Implement.'); await until('implementation settled', () => settled(events) === 1);
  assert.equal(s.requests.at(-1)!.messages.filter(message => message.role === 'user').length, 2, 'implementation continues the planning conversation');
  assert.deepEqual(s.resolved, ['fixture/planner', 'fixture/coder']);
  await agent.close();
  const missing = new DurableAgent({ ...s.options({ model: 'fixture/missing' }), runtime: s.runtime });
  await assert.rejects(missing.start(), /Model not found/);
  const again = await s.open();
  assert.equal(again.agent.resumedWork, false, 'a failed start released the worktree writer lock');
});

test('one writer per worktree, steering joins the running turn, and abort stops a running tool', async t => {
  const s = await setup(t);
  s.respond(call('bash', { command: 'sleep 0.4; echo first' }), context => fauxAssistantMessage([fauxText(`saw ${JSON.stringify(context.messages.at(-1))}`)]),
    call('bash', { command: 'sleep 30' }), () => fauxAssistantMessage([fauxText('aborted')]));
  const { agent, events } = await s.open();
  await assert.rejects(new DurableAgent({ ...s.options({ sessionId: 'gho-7-reviewer', role: 'reviewer' }), runtime: s.runtime }).start(), /already running|lock/i);
  await agent.prompt('Start.');
  await until('first tool running', () => events.some(event => event.type === 'tool_execution_start'));
  assert.deepEqual(await agent.steer('[gho-message:1]\nUse the boundary test.'), { disposition: 'queued' });
  await until('steered run settled', () => settled(events) === 1);
  const users = (await agent.getMessages() as Array<{ role: string; content: unknown }>).filter(message => message.role === 'user');
  assert.equal(users.length, 2); assert.match(JSON.stringify(users[1]!.content), /gho-message:1/);
  assert.equal(s.requests.length, 2, 'the steer joined the running turn instead of starting another run');
  await agent.prompt('Run the long command.');
  await until('long tool running', () => events.filter(event => event.type === 'tool_execution_start').length === 2);
  const started = Date.now();
  await agent.abort();
  assert.ok(Date.now() - started < 5_000, 'abort does not wait for the 30 second command');
  await until('aborted run settled', () => settled(events) === 2);
});

test('closing mid-turn keeps the turn; the next start resumes it and reports the interrupted tool', async t => {
  const s = await setup(t);
  s.respond(call('bash', { command: 'sleep 30' }),
    context => fauxAssistantMessage([fauxToolCall('gho_report', { kind: 'needs_input', summary: `after ${JSON.stringify(context.messages.at(-1))}` })], { stopReason: 'toolUse' }));
  const first = await s.open();
  await first.agent.prompt('Long phase.');
  await until('tool running', () => first.events.some(event => event.type === 'tool_execution_start'));
  const closing = Date.now();
  await first.agent.close();
  assert.ok(Date.now() - closing < 5_000, 'close does not wait for the tool');
  assert.equal(settled(first.events), 0, 'closing is not settlement');
  const second = await s.open();
  assert.equal(second.agent.resumedWork, true);
  await until('resumed turn settled', () => settled(second.events) === 1);
  const report = JSON.parse(await readFile(join(s.root, '.gho', 'reports', 'token-1.json'), 'utf8')) as { kind: string; summary: string };
  assert.equal(report.kind, 'needs_input'); assert.match(report.summary, /interrupted/);
  assert.equal((await second.agent.getMessages() as Array<{ role: string }>).filter(message => message.role === 'user').length, 1);
});

test('report kinds are validated against the role and conflicting reports are rejected', async t => {
  const s = await setup(t);
  s.respond(call('gho_report', { kind: 'skeleton_ready', summary: 'wrong role' }), () => fauxAssistantMessage([fauxText('stopped')]));
  const { agent, events } = await s.open({ sessionId: 'gho-7-reviewer', role: 'reviewer' });
  await agent.prompt('Review.');
  await until('settled', () => settled(events) === 1);
  await assert.rejects(readFile(join(s.root, '.gho', 'reports', 'token-1.json')), { code: 'ENOENT' });
  const end = events.find(event => event.type === 'tool_execution_end') as { isError: boolean; result: unknown };
  assert.equal(end.isError, true); assert.match(JSON.stringify(end.result), /does not match agent role/);
});

test('closing during startup releases every resource startup acquired', async t => {
  const s = await setup(t);
  for (let i = 0; i < 5; i++) {
    const agent = new DurableAgent({ ...s.options(), runtime: s.runtime });
    const starting = agent.start();
    await new Promise(done => setTimeout(done, i * 5));
    await agent.close();
    await starting.catch(() => {});
  }
  s.respond(() => fauxAssistantMessage([fauxText('ok')]));
  const { agent, events } = await s.open();
  await agent.prompt('After cancelled starts.');
  await until('settled', () => settled(events) === 1);
});
