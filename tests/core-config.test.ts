import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { githubRemoteRepo, initConfig, loadConfig, locate, resolvePath } from '../orchestrator/core/config.js';
import { SystemRunner, type Runner } from '../orchestrator/core/process.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gho-config-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), dir = join(root, 'config'); await mkdir(checkout);
  const system = new SystemRunner(); let ghCalls = 0;
  const runner: Runner = { run: async command => {
    if (command.argv[0] === 'gh') { ghCalls++; assert.deepEqual(command.argv, ['gh', 'api', '--hostname', 'github.com', 'user', '--jq', '.login']); return 'alice\n'; }
    return system.run({ ...command, env: { ...command.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root } });
  } };
  const git = (...args: string[]) => runner.run({ argv: ['git', ...args], cwd: checkout });
  await git('init', '-b', 'main'); await git('remote', 'add', 'origin', 'git@github.com:ACME/Repo.git');
  return { root, checkout, dir, runner, git, ghCalls: () => ghCalls, global: join(dir, 'config.toml'), local: join(dir, 'repos/acme/repo.toml') };
}

test('init works outside Git, resolves subdirectories and writes only missing config files', async t => {
  const f = await fixture(t);
  const global = await initConfig(f.root, f.dir, f.runner);
  assert.equal(global.repo, null); assert.deepEqual(global.files, [{ path: f.global, created: true }]);
  await assert.rejects(readFile(f.local), { code: 'ENOENT' });
  await mkdir(join(f.checkout, 'sub'));
  assert.deepEqual(await locate(join(f.checkout, 'sub'), f.runner), { checkout: f.checkout, repo: 'acme/repo' });
  const local = await initConfig(join(f.checkout, 'sub'), f.dir, f.runner);
  assert.deepEqual(local.files.map(file => file.created), [false, true]);
  assert.match(await readFile(f.local, 'utf8'), /base_branch = "main"/);
  await writeFile(f.local, 'project_url = "https://github.com/orgs/acme/projects/7"\nbase_branch = "develop"\n');
  const before = await Promise.all([readFile(f.global, 'utf8'), readFile(f.local, 'utf8')]);
  assert.ok((await initConfig(f.checkout, f.dir, f.runner)).files.every(file => !file.created));
  assert.deepEqual(await Promise.all([readFile(f.global, 'utf8'), readFile(f.local, 'utf8')]), before);
  assert.equal(f.ghCalls(), 1, 'an existing global config does not need GitHub authentication');
});

test('invalid origins fail initialization before any config is written', async t => {
  const f = await fixture(t);
  await f.git('remote', 'set-url', 'origin', 'https://gitlab.com/acme/repo.git');
  await assert.rejects(initConfig(f.checkout, f.dir, f.runner), /not a github.com repository/);
  await assert.rejects(readFile(f.global), { code: 'ENOENT' });
  await f.git('remote', 'remove', 'origin');
  await assert.rejects(initConfig(f.checkout, f.dir, f.runner), /no origin/);
  await assert.rejects(readFile(f.global), { code: 'ENOENT' });
  for (const remote of ['https://github.com/ACME/Repo.git', 'https://github.com/ACME/Repo', 'git@github.com:ACME/Repo.git']) assert.equal(githubRemoteRepo(remote), 'acme/repo');
  for (const remote of ['https://token@github.com/acme/repo.git', 'https://github.com.evil/acme/repo', '/tmp/repo', 'ssh://evil/path']) assert.equal(githubRemoteRepo(remote), null);
});

test('config defaults and path resolution preserve missing vault paths through symlinked parents', async t => {
  const f = await fixture(t); await initConfig(f.checkout, f.dir, f.runner);
  await writeFile(f.local, 'project_url = "https://github.com/orgs/acme/projects/7"\n');
  await symlink(f.root, join(f.checkout, 'alias'));
  await writeFile(f.global, 'owner = "alice"\n[obsidian]\nvault = "alias/not-created/vault"\n');
  const config = await loadConfig(f.checkout, f.dir, f.runner);
  assert.equal(config.base_branch, 'main'); assert.deepEqual(config.agents, {});
  assert.equal(config.vault, join(f.root, 'not-created/vault'));
  assert.equal(await resolvePath(join(f.checkout, 'alias/not-created/config')), join(f.root, 'not-created/config'));
  await writeFile(f.global, 'owner = "alice"\n[obsidian]\nvault = ""\n');
  assert.equal((await loadConfig(f.checkout, f.dir, f.runner)).vault, null);
});

test('config rejects invalid values and unknown keys at every supported table', async t => {
  const f = await fixture(t); await initConfig(f.checkout, f.dir, f.runner);
  const global = 'owner = "alice"\n', local = 'project_url = "https://github.com/users/alice/projects/1"\n';
  for (const value of ['owner = "bad owner"', 'owner = 42', `${global}extra = true`, `${global}[agents]\nimplementer_model = "bad model"`, `${global}[agents]\nreviewer_model = 42`, `${global}[obsidian]\nvaul = "typo"`, `${global}[orchestration]\nmax_attempts = 0`, `${global}[orchestration]\npoll_interval_ms = 1.5`, `${global}[orchestration]\nmax_concurency = 3`]) {
    await writeFile(f.global, value); await writeFile(f.local, local);
    await assert.rejects(loadConfig(f.checkout, f.dir, f.runner), value);
  }
  for (const value of ['project_url = ""', 'project_url = "https://github.com/acme/repo/projects/1"', `${local}base_branch = "../main"`, `${local}branch = "typo"`, `${local}[orchestration]\nmax_attempts = -1`]) {
    await writeFile(f.global, global); await writeFile(f.local, value);
    await assert.rejects(loadConfig(f.checkout, f.dir, f.runner), value);
  }
  await rm(f.global); await assert.rejects(loadConfig(f.checkout, f.dir, f.runner), error => error instanceof Error && error.message.includes(f.global) && error.message.includes('gho init'));
});
