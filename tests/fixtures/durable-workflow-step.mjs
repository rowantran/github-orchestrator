// Test-only work step that a faux model runs through the durable bash tool. It runs Git locally, never GitHub.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const context = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const fixturePath = join(process.cwd(), '.gho', 'workflow.json');
const load = () => JSON.parse(readFileSync(fixturePath, 'utf8'));
const save = value => { writeFileSync(`${fixturePath}.tmp`, JSON.stringify(value)); renameSync(`${fixturePath}.tmp`, fixturePath); };
const git = async args => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: process.cwd(), timeout: 10_000 })).stdout.trim();
if (load().fixture !== 'gho-workflow-test' || process.env.PI_SESSION_ID === undefined) throw new Error('Run only inside a durable workflow fixture.');

let fixture = load();
const token = context.phaseToken;
fixture.contexts.push({ phase: context.phase, token, sessionId: process.env.PI_SESSION_ID, model: `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}`, feedback: context.feedback, approvedSha: context.approvedSha, reviewTargetSha: context.reviewTargetSha });
save(fixture);
if (context.phase !== 'reviewing' && !fixture.commitTokens.includes(token)) {
  const planning = context.phase === 'planning';
  const revision = planning ? fixture.planningCommits + 1 : fixture.implementationCommits + 1;
  const file = planning ? 'skeleton.md' : 'implementation.ts';
  writeFileSync(join(process.cwd(), file), planning ? `# Skeleton revision ${revision}\nPhase: ${token}\n` : `export const implementedRevision = ${revision};\n// Approved skeleton: ${context.approvedSha}\n`);
  await git(['add', '--', file]);
  await git(['-c', 'user.name=Workflow Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', `${planning ? 'Skeleton' : 'Implementation'} revision ${revision}`]);
  fixture = load();
  fixture.commitTokens.push(token);
  if (planning) fixture.planningCommits++; else fixture.implementationCommits++;
  fixture.pr ??= { number: fixture.issue + 1000, url: `https://github.com/fixture/repo/pull/${fixture.issue + 1000}`, head: context.branch, base: context.baseBranch, draft: true, state: 'OPEN', checks: fixture.checks, feedback: [] };
  fixture.pr.headSha = await git(['rev-parse', 'HEAD']);
  save(fixture);
  if (fixture.holdPhases.includes(context.phase)) {
    // A long-running tool call: the test restarts the service while this waits.
    writeFileSync(join(process.cwd(), '.gho', 'step-holding'), token);
    while (!existsSync(join(process.cwd(), '.gho', 'step-release'))) await delay(50);
  }
}
console.log(`${context.phase} step complete at ${load().pr?.headSha}`);
