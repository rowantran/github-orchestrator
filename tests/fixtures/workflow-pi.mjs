// Deterministic test-only Pi RPC process. It runs Git locally, never a model or GitHub command.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const sessionId = option('--session-id');
const sessionDir = option('--session-dir');
const configuredModel = option('--model');
const phaseToken = process.env.GHO_PHASE_TOKEN;
const reportPath = process.env.GHO_REPORT_PATH;
const role = process.env.GHO_AGENT_ROLE;
const fixturePath = join(process.cwd(), '.gho', 'workflow.json');
const load = () => JSON.parse(readFileSync(fixturePath, 'utf8'));
const save = value => {
  const temporary = `${fixturePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, fixturePath);
};
if (load().fixture !== 'gho-workflow-test' || !sessionId || !sessionDir || !configuredModel || !phaseToken || !reportPath) {
  throw new Error('This fixture requires a temporary workflow checkout and the Pi RPC driver environment.');
}
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
if (!existsSync(sessionFile)) writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId })}\n`);
const messages = readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message').map(entry => entry.message);
const model = configuredModel.split('/');
const state = { sessionId, sessionFile, model: { provider: model[0], id: model.slice(1).join('/') }, thinkingLevel: 'medium', isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
const journal = (name, value) => appendFileSync(join(process.cwd(), '.gho', name), `${JSON.stringify(value)}\n`);
journal('workflow-launches.jsonl', { sessionId, role, model: configuredModel, phaseToken, pid: process.pid, previousMessages: messages.length });
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const reply = (command, data) => emit({ id: command.id, type: 'response', command: command.type, success: true, ...(data === undefined ? {} : { data }) });
function message(role, text) {
  const entry = { role, content: [{ type: 'text', text }], timestamp: Date.now() };
  messages.push(entry);
  appendFileSync(sessionFile, `${JSON.stringify({ type: 'message', message: entry })}\n`);
  emit({ type: 'message_end', message: entry });
}
async function git(args) {
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: process.cwd(), timeout: 10_000 })).stdout.trim();
}
let activeContext;
let phaseWork = Promise.resolve();
async function finish(context) {
  const fixture = load();
  let kind;
  if (context.phase === 'planning') kind = 'skeleton_ready';
  else if (context.phase === 'implementing') kind = 'implementation_ready';
  else {
    const previous = fixture.reviewTokens.find(entry => entry.token === phaseToken);
    if (previous) kind = previous.kind;
    else {
      kind = fixture.requestChangesOnce && fixture.reviewTokens.length === 0 ? 'changes_requested' : 'review_passed';
      fixture.reviewTokens.push({ token: phaseToken, kind, sha: fixture.pr.headSha });
      save(fixture);
    }
  }
  const report = { phaseToken, kind, summary: `${context.phase}: verified local revision ${fixture.pr.headSha}`, ...(kind === 'changes_requested' ? { findings: ['Add an empty-input test before publishing.'] } : {}) };
  const temporary = `${reportPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(report));
  renameSync(temporary, reportPath);
  message('assistant', `${kind} at ${fixture.pr.headSha}`);
  emit({ type: 'tool_execution_end', toolName: 'gho_report', result: { content: [{ type: 'text', text: JSON.stringify(report) }] }, isError: false });
  emit({ type: 'agent_end', messages: [], willRetry: false });
  state.isStreaming = false;
  activeContext = undefined;
  emit({ type: 'agent_settled' });
}
async function runPhase(context) {
  if (context.phaseToken !== phaseToken || (context.phase === 'reviewing') !== (role === 'reviewer')) throw new Error('Workflow phase identity mismatch.');
  let fixture = load();
  fixture.contexts.push({ phase: context.phase, token: phaseToken, sessionId, model: configuredModel, feedback: context.feedback, approvedSha: context.approvedSha, reviewTargetSha: context.reviewTargetSha });
  save(fixture);
  if (context.phase === 'implementing' && !context.approvedSha) throw new Error('Fixture refuses implementation without a recorded approval.');
  if (context.phase === 'reviewing' && context.reviewTargetSha !== await git(['rev-parse', 'HEAD'])) throw new Error('Reviewer was not assigned the real worktree revision.');
  if (context.phase !== 'reviewing' && !fixture.commitTokens.includes(phaseToken)) {
    const planning = context.phase === 'planning';
    const revision = planning ? fixture.planningCommits + 1 : fixture.implementationCommits + 1;
    const file = planning ? 'skeleton.md' : 'implementation.ts';
    const feedback = [context.feedback, ...(context.operatorMessages ?? []).map(message => message.text)].filter(Boolean).join('\n') || 'none';
    writeFileSync(join(process.cwd(), file), planning ? `# Skeleton revision ${revision}\nPhase: ${phaseToken}\nFeedback: ${feedback}\n` : `export const implementedRevision = ${revision};\n// Approved skeleton: ${context.approvedSha}\n// Dispatch: ${phaseToken}\n`);
    await git(['add', '--', file]);
    await git(['-c', 'user.name=Workflow Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', `${planning ? 'Skeleton' : 'Implementation'} revision ${revision}`]);
    fixture = load();
    fixture.commitTokens.push(phaseToken);
    if (planning) fixture.planningCommits++; else fixture.implementationCommits++;
    fixture.pr ??= { number: fixture.issue + 1000, url: `https://github.com/fixture/repo/pull/${fixture.issue + 1000}`, head: context.branch, base: context.baseBranch, draft: true, state: 'OPEN', checks: fixture.checks, feedback: [] };
    fixture.pr.headSha = await git(['rev-parse', 'HEAD']);
    fixture.pr.draft = true;
    save(fixture);
  }
  if (fixture.holdPhases.includes(context.phase)) {
    activeContext = context;
    message('assistant', `Waiting for operator nudge after ${context.phase} checkpoint.`);
    // An intermediate agent_end must not make the engine consume an absent report.
    emit({ type: 'agent_end', messages: [], willRetry: true });
    return;
  }
  await finish(context);
}
function schedule(action) {
  phaseWork = phaseWork.then(action).catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  });
}
emit({ type: 'extension_ui_request', id: 'report-ready', method: 'setStatus', statusKey: 'gho:report', statusText: JSON.stringify({ phaseToken, reportPath }) });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    journal('workflow-rpc.jsonl', { ...command, sessionId, phaseToken });
    if (command.type === 'get_state') reply(command, state);
    else if (command.type === 'get_messages') reply(command, { messages });
    else if (command.type === 'prompt') {
      const context = JSON.parse(command.message.slice(command.message.indexOf('{')));
      message('user', command.message);
      state.isStreaming = true; emit({ type: 'agent_start' }); reply(command, { disposition: 'started' });
      schedule(() => runPhase(context));
    } else if (command.type === 'steer') {
      message('user', command.message); reply(command, { disposition: 'queued' });
      schedule(async () => {
        const fixture = load(); fixture.nudges.push(command.message);
        if (activeContext) fixture.holdPhases = fixture.holdPhases.filter(phase => phase !== activeContext.phase);
        save(fixture);
        if (activeContext) await finish(activeContext);
      });
    } else if (command.type === 'clear_queue') { state.pendingMessageCount = 0; reply(command, { steering: [], followUp: [] }); }
    else if (command.type === 'abort') { state.isStreaming = false; reply(command); emit({ type: 'agent_settled' }); }
    else emit({ id: command.id, type: 'response', command: command.type, success: false, error: `Unsupported workflow fixture RPC: ${command.type}` });
  }
});
process.stdin.on('end', () => process.exit(0));
