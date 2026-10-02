import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableAgent, PiDurableRuntime } from '../orchestrator/agents/durable/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url));

test('durable workers inherit Pi settings, extension providers, AGENTS.md, skills and APPEND_SYSTEM.md, and stream through the provider', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gho-pi-runtime-'));
  const bodies: Array<Record<string, unknown>> = [];
  // An OpenAI-compatible local fake. No real provider or credential is used.
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'worker-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(chunk({ role: 'assistant', content: 'fixture-answer' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address !== 'string');
  process.env.GHO_TEST_PROVIDER_URL = `http://127.0.0.1:${address.port}/v1`;
  let agent: DurableAgent | undefined;
  t.after(async () => {
    await agent?.close();
    delete process.env.GHO_TEST_PROVIDER_URL;
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, 'agent'), cwd = join(root, 'worktree');
  for (const directory of [agentDir, join(agentDir, 'skills', 'fixture'), cwd]) await mkdir(directory, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'extension-fixture', defaultModel: 'worker-model', defaultThinkingLevel: 'off',
    extensions: [fixture('durable-provider-extension.mjs')], retry: { enabled: false },
  }));
  await writeFile(join(agentDir, 'AGENTS.md'), 'fixture-user-context-sentinel\n');
  await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'fixture-append-system-sentinel\n');
  await writeFile(join(agentDir, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: fixture-skill-sentinel\n---\nfixture-skill\n');
  await writeFile(join(cwd, 'AGENTS.md'), 'fixture-project-context-sentinel\n');
  await writeFile(join(root, 'worker.md'), '<!-- Purpose: test. -->\nfixture-worker-instructions\n');

  const runtime = await PiDurableRuntime.create(cwd, agentDir);
  assert.deepEqual(runtime.diagnostics, []);
  assert.deepEqual(await runtime.resolveModel(undefined), { model: { provider: 'extension-fixture', modelId: 'worker-model' }, thinkingLevel: 'off' });
  await assert.rejects(runtime.resolveModel('extension-fixture/absent-model'), /Cannot resolve model/);
  const resources = await runtime.resources(cwd, ['read', 'bash', 'edit', 'write']);
  const prompt = Object.values(resources.sections).join('\n');
  for (const sentinel of ['fixture-user-context-sentinel', 'fixture-project-context-sentinel', 'fixture-append-system-sentinel', 'fixture-skill-sentinel', 'Use edit for precise changes'])
    assert.ok(prompt.includes(sentinel), sentinel);

  const events: Array<Record<string, unknown>> = [];
  agent = new DurableAgent({ cwd, sessionId: 'gho-1-implementer', sessionDir: join(cwd, '.gho', 'sessions'), role: 'implementer',
    instructionsPath: join(root, 'worker.md'), reportPath: join(cwd, '.gho', 'reports', 'r.json'), phaseToken: 'token', runtime });
  agent.onEvent(event => events.push(event));
  await agent.start();
  await agent.prompt('Say something.');
  const deadline = Date.now() + 15_000;
  while (!events.some(event => event.type === 'agent_settled') && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(events.some(event => event.type === 'agent_settled'), JSON.stringify(events.slice(-5)));
  assert.equal(bodies.length, 1, JSON.stringify(events.filter(event => !String(event.type).startsWith('message_update')), null, 1).slice(0, 3000));
  assert.equal(bodies[0]!.model, 'worker-model');
  const sent = JSON.stringify(bodies[0]!.messages);
  for (const sentinel of ['fixture-project-context-sentinel', 'fixture-skill-sentinel', 'fixture-worker-instructions', 'Say something.']) assert.ok(sent.includes(sentinel), sentinel);
  assert.ok((bodies[0]!.tools as Array<{ function: { name: string } }>).some(tool => tool.function.name === 'gho_report'));
  const messages = await agent.getMessages() as Array<{ role: string; content: unknown }>;
  assert.match(JSON.stringify(messages.at(-1)), /fixture-answer/);
  assert.ok((await readFile(join(cwd, '.gho', 'sessions', 'gho-1-implementer.sqlite'))).length > 0);
});
