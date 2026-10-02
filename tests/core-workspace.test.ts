import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../orchestrator/core/workspace.js';
import { SystemRunner, type Command, type Runner } from '../orchestrator/core/process.js';
import type { Config } from '../orchestrator/core/types.js';

async function repository(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gho-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  // No developer hooks, signing, Worktrunk configuration, or Git environment in these repositories.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith('GIT_') || k.startsWith('WORKTRUNK_')).map(k => [k, undefined]));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const system = new SystemRunner();
  const runner: Runner = { run: (command: Command) => {
    const argv = command.argv[0] === 'wt' ? ['wt', '--config', '/dev/null', ...command.argv.slice(1)] : command.argv;
    return system.run({ ...command, argv, env: { ...command.env, ...env } });
  } };
  const git = async (cwd: string, ...args: string[]) => (await runner.run({ argv: ['git', ...args], cwd })).trim();
  const commit = async (cwd: string, file: string) => {
    await writeFile(join(cwd, file), `${file}\n`);
    await git(cwd, 'add', '--', file);
    await git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', file);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), checkout = join(root, 'checkout with spaces');
  await git(root, 'init', '--bare', '-b', 'main', origin);
  await git(root, 'clone', origin, seed);
  await commit(seed, 'initial.txt'); await git(seed, 'push', 'origin', 'HEAD:main');
  await git(root, 'clone', origin, checkout);
  const config: Config = { repo: 'acme/repo', owner: 'alice', checkout, project_url: 'https://github.com/users/alice/projects/1', base_branch: 'main', vault: null, agents: {} };
  return { root, seed, checkout, config, runner, git, commit, workspace: new Workspace(config, runner) };
}
async function hasWorktrunk(runner: Runner): Promise<boolean> {
  try { await runner.run({ argv: ['wt', '--version'] }); return true; }
  catch (error) { if (error instanceof Error && /^Cannot run wt:.*ENOENT/.test(error.message)) return false; throw error; }
}

test('real Worktrunk creates from latest fetched base and preserves local and commit stacking', async t => {
  const { runner, workspace, seed, checkout, git, commit } = await repository(t);
  if (!await hasWorktrunk(runner)) { t.skip('Worktrunk is not installed'); return; }
  const latest = await commit(seed, 'landed-after-clone.txt'); await git(seed, 'push', 'origin', 'main');
  const first = await workspace.create(1); await workspace.writeBrief(first, 'A real worktree');
  assert.equal(first.base, 'origin/main'); assert.equal(first.base_branch, 'main'); assert.equal(first.base_commit, latest);
  assert.equal(await git(first.path, 'rev-parse', 'HEAD'), latest);
  assert.equal(await git(first.path, 'branch', '--show-current'), 'alice/gh-1');
  assert.equal((await workspace.worktrees()).get('alice/gh-1'), first.path);
  assert.equal(await git(first.path, 'status', '--porcelain'), '', 'the task brief remains ignored');
  assert.equal(await git(checkout, 'status', '--porcelain'), '');

  const upstream = await commit(first.path, 'unmerged.txt');
  const stacked = await workspace.create(2, 'alice/gh-1');
  assert.equal(stacked.base_branch, 'alice/gh-1'); assert.equal(stacked.base_commit, upstream);
  assert.equal(await readFile(join(stacked.path, 'unmerged.txt'), 'utf8'), 'unmerged.txt\n');
  const detachedBase = await workspace.create(3, upstream);
  assert.equal(detachedBase.base_commit, upstream); assert.equal(detachedBase.base_branch, 'main');
  await assert.rejects(workspace.create(1), /already exists at/);
  await git(checkout, 'branch', 'alice/gh-4');
  const original = await git(checkout, 'rev-parse', 'alice/gh-4');
  await assert.rejects(workspace.create(4), /already exists \(no worktree\)/);
  assert.equal(await git(checkout, 'rev-parse', 'alice/gh-4'), original);
});

test('fetching a remote-only blocker uses its latest pushed commit without creating a local branch', async t => {
  const { runner, workspace, seed, checkout, git, commit } = await repository(t);
  await git(seed, 'switch', '-c', 'alice/gh-8');
  const pushed = await commit(seed, 'blocker.txt'); await git(seed, 'push', 'origin', 'alice/gh-8');
  assert.equal(await workspace.fetch('alice/gh-8'), 'origin/alice/gh-8');
  assert.equal(await git(checkout, 'rev-parse', 'origin/alice/gh-8'), pushed);
  assert.equal(await workspace.branchExists('alice/gh-8'), false);
  if (!await hasWorktrunk(runner)) { t.diagnostic('Worktrunk not installed; remote fetch assertions passed'); return; }
  const stacked = await workspace.create(9, 'origin/alice/gh-8');
  assert.equal(stacked.base_commit, pushed); assert.equal(stacked.base_branch, 'alice/gh-8');
});

test('real Git validates checkout identity, preserves unusual worktree paths and propagates failures', async t => {
  const { root, workspace, checkout, config, runner, git } = await repository(t);
  await assert.rejects(workspace.verifyCheckout(), /origin/);
  await git(checkout, 'remote', 'set-url', 'origin', 'git@github.com:ACME/Repo.git');
  await workspace.verifyCheckout();
  await mkdir(join(checkout, 'sub'));
  await assert.rejects(new Workspace({ ...config, checkout: join(checkout, 'sub') }, runner).verifyCheckout(), /repository root/);
  assert.equal(await workspace.branchExists('main'), true);
  assert.equal(await workspace.branchExists('alice/gh-99'), false);
  await assert.rejects(new Workspace({ ...config, checkout: root }, runner).branchExists('main'), /git/);
  await assert.rejects(workspace.create(3, 'no-such-base'), /Unknown base "no-such-base"/);
  assert.equal(await workspace.branchExists('alice/gh-3'), false);
  const oddPath = join(root, 'tree with \"quotes\"\nand newline');
  await git(checkout, 'worktree', 'add', '-b', 'alice/gh-6', oddPath, 'main');
  assert.equal((await workspace.worktrees()).get('alice/gh-6'), oddPath);
  await git(checkout, 'checkout', '--detach');
  await assert.rejects(workspace.currentBranch(), /detached HEAD/);
});
