import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surveyIssues, type Issues } from '../orchestrator/core/work.js';
import { issueKey, issueRef, linked, parseIssue, workstreamLabel, workstreamNames } from '../orchestrator/core/domain.js';
import type { Config, Issue, PullRequest } from '../orchestrator/core/types.js';
import { CommandError, SystemRunner, type Runner } from '../orchestrator/core/process.js';
import { initConfig, loadConfig, resolvePath } from '../orchestrator/core/config.js';
import { Workspace, renderBrief } from '../orchestrator/core/workspace.js';

const config: Config = { repo: 'acme/repo', owner: 'alice', checkout: '/tmp', project_url: 'https://github.com/users/alice/projects/1', base_branch: 'main', vault: null, agents: {} };
const task = (number: number, blockers: number[] = []): Issue => ({ reference: issueRef(config.repo, number), title: `Task ${number}`, body: '', state: 'OPEN', state_reason: null, assignees: ['alice'], project_ids: ['P'], blockers: blockers.map(n => issueRef(config.repo, n)), pull_requests: [] });
const pr = (number: number, base = 'main', draft = false): PullRequest => ({ number: number + 100, url: `https://github.com/acme/repo/pull/${number + 100}`, repo: config.repo, state: 'OPEN', draft, base, head: `alice/gh-${number}`, merge_commit: null });
function source(issues: Issue[], prs: PullRequest[] = []): Issues {
  return { issue: async ref => { const issue = issues.find(i => issueKey(i.reference) === issueKey(ref)); assert.ok(issue, `fixture missing ${issueKey(ref)}`); return issue; }, openPullRequest: async branch => prs.find(p => p.head === branch) ?? null };
}
const noBranches = { worktrees: async () => new Map<string, string>(), branchExists: async () => false };

test('ready classification keeps completed and abandoned closures distinct', async () => {
  const done = { ...task(1), state: 'CLOSED' as const, state_reason: 'COMPLETED' as const }, closed = { ...task(2), state: 'CLOSED' as const, state_reason: 'DUPLICATE' as const };
  const issues = [done, closed, task(3, [1]), task(4, [2])];
  const entries = await surveyIssues(config, source(issues), noBranches, issues);
  assert.deepEqual(entries.map(e => e.state), ['done', 'closed', 'ready', 'blocked']);
});
test('draft PR and local branches are in progress and do not unblock work', async () => {
  const issues = [task(1), task(2, [1]), task(3)];
  const entries = await surveyIssues(config, source(issues, [pr(1, 'main', true)]), { ...noBranches, branchExists: async b => b === 'alice/gh-3' }, issues);
  assert.deepEqual(entries.map(e => e.state), ['in_progress', 'blocked', 'in_progress']);
});
test('published blockers must share a stack, including intermediate PRs', async () => {
  const issues = [task(1), task(2), task(4, [2, 1])], prs = [pr(1), pr(2, 'alice/gh-3'), pr(3, 'alice/gh-1', true)];
  const result = await surveyIssues(config, source(issues, prs), noBranches, issues);
  assert.deepEqual(result[2]?.state === 'ready' && result[2].stack_on, [1, 2]);
  const split = await surveyIssues(config, source(issues, [pr(1), pr(2)]), noBranches, issues);
  assert.equal(split[2]?.state, 'blocked');
});
test('cycles block and external issues do not reuse local branches', async () => {
  const a = task(1, [2]), b = task(2, [1]), external = { ...task(9), reference: issueRef('other/repo', 9) }, c = { ...task(3), blockers: [external.reference] };
  const entries = await surveyIssues(config, source([a, b, c, external], [pr(9)]), noBranches, [a, b, c]);
  assert.deepEqual(entries.map(e => e.state), ['blocked', 'blocked', 'blocked']); assert.equal(entries[2]?.blockers[0]?.branch, null);
});
test('dependency details retain historical PRs and local worktrees without refetching surveyed issues', async () => {
  const historical = { ...pr(1), state: 'MERGED' as const, head: 'someone/feature' };
  const blocker = { ...task(1), pull_requests: [historical] }, dependent = { ...task(2, [1]), body: 'Keep issue instructions.' };
  const issues = [dependent, blocker];
  const src: Issues = { issue: async () => { throw new Error('Surveyed issue must not be fetched again'); }, openPullRequest: async () => null };
  const entries = await surveyIssues(config, src, { ...noBranches, worktrees: async () => new Map([['alice/gh-1', '/temporary/tree']]) }, issues);
  assert.equal(entries[0]?.state, 'blocked'); assert.equal(entries[0]?.body, dependent.body);
  assert.equal(entries[0]?.branch, 'alice/gh-2'); assert.equal(entries[0]?.worktree, null);
  const detail = entries[0]?.blockers[0]; assert.ok(detail);
  assert.equal(detail.state, 'in_progress'); assert.equal(detail.branch, 'alice/gh-1'); assert.equal(detail.worktree, '/temporary/tree');
  assert.deepEqual(detail.pull_requests, [linked(historical)]);
  const done = { ...blocker, state: 'CLOSED' as const, state_reason: 'COMPLETED' as const };
  const completed = await surveyIssues(config, source([done, dependent]), noBranches, [dependent, done]);
  assert.equal(completed[0]?.state, 'ready'); assert.equal(completed[1]?.state, 'done');
});

test('every dependency must finish and external blockers never borrow same-number local work', async () => {
  const external = { ...task(1), reference: issueRef('other/repo', 1) };
  const done = { ...task(2), state: 'CLOSED' as const, state_reason: 'COMPLETED' as const };
  const dependent = { ...task(3), blockers: [done.reference, external.reference] };
  const workspace = { ...noBranches, worktrees: async () => new Map([['alice/gh-1', '/local/tree']]) };
  const entry = (await surveyIssues(config, source([external, done], [pr(1)]), workspace, [dependent]))[0]!;
  assert.equal(entry.state, 'blocked'); assert.equal(entry.blockers[0]?.state, 'done');
  assert.equal(entry.blockers[1]?.state, 'ready'); assert.equal(entry.blockers[1]?.branch, null); assert.equal(entry.blockers[1]?.worktree, null);
  assert.equal(entry.blockers[1]?.repo, 'other/repo');
});

test('workstream labels honor the exact GitHub length boundary and do not inherit parents', () => {
  assert.equal(workstreamLabel('a'.repeat(35)).length, 50);
  assert.throws(() => workstreamLabel('a'.repeat(36)), /Invalid workstream name/);
  assert.deepEqual(workstreamNames(['bug', 'gho:workstream:project/child', 'gho:workstream:other']), ['other', 'project/child']);
  for (const name of ['a/../b', 'a\\b', 'a?b', 'a#b', 'a b', 'a\nb', '/root', 'trailing/']) assert.throws(() => workstreamLabel(name));
});

test('issue and workstream inputs reject traversal and invalid references', () => {
  assert.deepEqual(parseIssue('https://github.com/ACME/Repo/issues/42/'), { repo: 'acme/repo', number: 42 });
  for (const bad of ['0', '-2', '1e3', 'https://github.com/acme/repo/pull/4', '9007199254740992']) assert.throws(() => parseIssue(bad, config.repo));
  for (const bad of ['../oops', 'one//two', '-option', 'a,b', 'a'.repeat(37)]) assert.throws(() => workstreamLabel(bad));
  assert.equal(workstreamLabel('One/two_3'), 'gho:workstream:One/two_3');
});
test('brief substitutes once and removes only the injection header', async () => {
  const brief = await renderBrief({ number: 4, title: '{{branch}} remains literal', branch: 'alice/gh-4', base_branch: 'main', repo: config.repo, url: 'https://github.com/acme/repo/issues/4' });
  assert.match(brief, /# Issue #4: \{\{branch\}\} remains literal/); assert.match(brief, /Base branch: `main`/); assert.ok(!brief.startsWith('<!--'));
});
test('configuration remains TOML compatible, accepts planner model, rejects typos and never overwrites', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gho-core-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'config'); const runner: Runner = { run: async cmd => {
    if (cmd.argv[0] === 'gh') return 'alice\n';
    if (cmd.argv.includes('--show-toplevel')) return root;
    if (cmd.argv.includes('get-url')) return 'git@github.com:ACME/Repo.git';
    if (cmd.argv.includes('symbolic-ref')) return 'origin/trunk';
    throw new Error(`Unexpected ${cmd.argv.join(' ')}`);
  } };
  const initialized = await initConfig(root, dir, runner); assert.equal(initialized.files.filter(f => f.created).length, 2);
  await writeFile(join(dir, 'repos/acme/repo.toml'), 'project_url = "https://github.com/users/alice/projects/1"\nbase_branch = "trunk"\n[orchestration]\nmax_review_rounds = 3\n');
  await writeFile(join(dir, 'config.toml'), 'owner = "alice"\n[agents]\nplanner_model = "provider/model:high"\nreviewer_model = "provider/reviewer"\n[orchestration]\nmax_review_rounds = 8\nmax_concurrency = 2\n');
  const loaded = await loadConfig(root, dir, runner); assert.equal(loaded.repo, config.repo); assert.equal(loaded.agents.planner_model, 'provider/model:high'); assert.equal(loaded.base_branch, 'trunk'); assert.equal(loaded.orchestration?.max_review_rounds, 3); assert.equal(loaded.orchestration?.max_concurrency, 2);
  assert.ok((await initConfig(root, dir, runner)).files.every(f => !f.created));
  await writeFile(join(dir, 'config.toml'), 'owner = "alice"\n[agents]\nplaner_model = "typo"\n'); await assert.rejects(loadConfig(root, dir, runner), /Unknown config key/);
  assert.equal(await resolvePath(join(root, 'missing', 'deep')), join(root, 'missing', 'deep'));
});
test('worktree creation uses argument arrays, remote base, ignored brief and refuses reuse', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gho-core-tree-')); t.after(() => rm(root, { recursive: true, force: true })); const path = join(root, 'tree with spaces'); await mkdir(path);
  let created = false; const commands: string[][] = [];
  const runner: Runner = { run: async cmd => {
    commands.push([...cmd.argv]);
    if (cmd.argv.includes('list')) return created ? `worktree ${path}\0HEAD abc\0branch refs/heads/alice/gh-4\0\0` : '';
    if (cmd.argv.includes('--quiet')) throw new CommandError('git', 1, '');
    if (cmd.argv.includes('fetch') || cmd.argv.includes('config')) return '';
    if (cmd.argv.includes('--symbolic-full-name')) return 'refs/remotes/origin/main';
    if (cmd.argv.includes('--verify')) return 'a'.repeat(40);
    if (cmd.argv[0] === 'wt') { created = true; assert.equal(cmd.timeoutMs, 600_000); return '{}'; }
    throw new Error(`Unexpected ${cmd.argv.join(' ')}`);
  } };
  const workspace = new Workspace({ ...config, checkout: root }, runner), tree = await workspace.create(4); await workspace.writeBrief(tree, 'A task');
  assert.equal(tree.base, 'origin/main'); assert.equal(tree.base_branch, 'main'); assert.equal(tree.path, path); assert.equal(await readFile(join(path, '.gho/.gitignore'), 'utf8'), '*\n');
  assert.ok(commands.some(cmd => cmd.join(' ') === 'git fetch origin main')); await assert.rejects(workspace.create(4), /already exists/); await assert.rejects(workspace.writeBrief(tree, 'overwrite'), /but not its brief/);
});
test('worktree recovery reconstructs owned brief, verifies identity and refuses unrelated branches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gho-core-recover-')); t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'repo'), tree = join(root, 'task'); await mkdir(checkout);
  const system = new SystemRunner();
  const git = (args: string[]) => system.run({ argv: ['git', ...args], cwd: checkout });
  await git(['init', '-b', 'main']); await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base']);
  const runner: Runner = { run: async command => command.argv[0] === 'wt' ? git(['worktree', 'add', '-b', 'alice/gh-4', tree, command.argv[command.argv.indexOf('--base') + 1]!]) : system.run(command) };
  const workspace = new Workspace({ ...config, checkout }, runner);
  const created = await workspace.create(4, 'main'); // Simulate process death before writeBrief.
  const recovered = await workspace.recover(4, 'Recovered task'); assert.equal(recovered?.path, tree); assert.equal(recovered?.base_commit, created.base_commit); assert.match(await readFile(created.brief, 'utf8'), /Recovered task/);
  assert.equal((await workspace.recover(4, 'Do not rewrite'))?.brief, created.brief); assert.match(await readFile(created.brief, 'utf8'), /Recovered task/);
  await writeFile(created.brief, '# Issue #9: wrong identity'); await assert.rejects(workspace.recover(4, 'No'), /does not identify/);
  const unrelated = join(root, 'unrelated'); await git(['worktree', 'add', '-b', 'alice/gh-5', unrelated, 'main']); await assert.rejects(workspace.recover(5, 'No'), /refusing recovery/);
  assert.equal(await workspace.recover(6, 'Absent'), null);
});
test('system runner does not evaluate arguments, rejects exits and enforces deadlines', async () => {
  const runner = new SystemRunner(); const literal = '$(touch /tmp/never-run-gho); echo hi';
  assert.equal(await runner.run({ argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal] }), literal);
  await assert.rejects(runner.run({ argv: [process.execPath, '-e', 'process.stderr.write("bad");process.exit(7)'] }), (error: unknown) => error instanceof CommandError && error.code === 7);
  await assert.rejects(runner.run({ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'], timeoutMs: 30 }), /timed out/);
});
