import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Created } from './types.js';
import { branchName, ensure, issueUrl, issueRef } from './domain.js';
import { githubRemoteRepo } from './config.js';
import { CommandError, type Runner, systemRunner } from './process.js';

/** Find packaged resources from source or compiled dist without relying on the user's cwd. */
export async function resourcePath(relative: string): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) { const path = join(dir, relative); try { await readFile(path); return path; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } const next = dirname(dir); if (next === dir) break; dir = next; }
  throw new Error(`Package resource not found: ${relative}`);
}
export async function renderBrief(facts: Record<string, string | number>): Promise<string> {
  const template = await readFile(await resourcePath('agent-context/brief.md'), 'utf8');
  const body = template.startsWith('<!--') ? template.slice(template.indexOf('\n') + 1) : template;
  return body.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => { ensure(Object.hasOwn(facts, key), `Unknown brief placeholder: ${key}`); return String(facts[key]); });
}
export class Workspace {
  constructor(readonly config: Config, readonly runner: Runner = systemRunner) {}
  async git(args: string[], timeoutMs = 60_000): Promise<string> { return (await this.runner.run({ argv: ['git', ...args], cwd: this.config.checkout, timeoutMs })).trim(); }
  async verifyCheckout(): Promise<void> {
    ensure(await realpath(await this.git(['rev-parse', '--show-toplevel'])) === this.config.checkout, 'checkout must name the repository root.');
    ensure(githubRemoteRepo(await this.git(['remote', 'get-url', 'origin'])) === this.config.repo.toLowerCase(), "The checkout's origin does not match the configured GitHub repository.");
  }
  async branchExists(branch: string): Promise<boolean> { try { await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch (error) { if (error instanceof CommandError && error.code === 1) return false; throw error; } }
  async currentBranch(): Promise<string> { const branch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']); ensure(branch !== 'HEAD', 'No branch checked out (detached HEAD).'); return branch; }
  async worktrees(): Promise<Map<string, string>> {
    // -z prevents Git quoting unusual paths or interpreting embedded newlines as records.
    const data = await this.git(['worktree', 'list', '--porcelain', '-z']), result = new Map<string, string>(); let path: string | undefined;
    for (const line of data.split('\0')) { if (line.startsWith('worktree ')) path = line.slice(9); else if (line.startsWith('branch refs/heads/') && path) result.set(line.slice(18), path); }
    return result;
  }
  async fetch(branch: string): Promise<string> { ensure(!branch.startsWith('-') && !/[\0\r\n]/.test(branch), 'Invalid branch.'); await this.git(['fetch', 'origin', branch], 300_000); return `origin/${branch}`; }
  async create(number: number, base?: string): Promise<Created> {
    const branch = branchName(this.config, number), existing = (await this.worktrees()).get(branch);
    ensure(!existing, `Branch ${branch} already exists at ${existing}. Continue there, or remove it first.`);
    ensure(!await this.branchExists(branch), `Branch ${branch} already exists (no worktree). Continue there, or remove it first.`);
    base ??= await this.fetch(this.config.base_branch);
    ensure(base.length > 0 && !base.startsWith('-') && !/[\0\r\n]/.test(base), 'Invalid base.');
    let commit: string; try { commit = await this.git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]); } catch { throw new Error(`Unknown base ${JSON.stringify(base)}; use a branch, tag or commit.`); }
    const full = await this.git(['rev-parse', '--symbolic-full-name', base]);
    const base_branch = full.startsWith('refs/remotes/origin/') ? full.slice(20) : full.startsWith('refs/heads/') ? full.slice(11) : this.config.base_branch;
    // Persist only provisioning ownership, not task state. Write before Worktrunk so a crash after
    // branch creation can be recovered without claiming a user's unrelated canonical branch.
    for (const [key, value] of Object.entries({ ghoIssue: String(number), ghoRepo: this.config.repo.toLowerCase(), ghoBaseBranch: base_branch, ghoBaseCommit: commit, ghoBase: base })) await this.git(['config', '--local', `branch.${branch}.${key}`, value]);
    await this.runner.run({ argv: ['wt', '-C', this.config.checkout, 'switch', '--create', branch, '--base', commit, '--no-cd', '--format', 'json'], cwd: this.config.checkout, timeoutMs: 600_000 });
    const path = (await this.worktrees()).get(branch); ensure(path, `Worktrunk did not report a worktree for ${branch}.`);
    return { issue: number, branch, base, base_commit: commit, base_branch, path, brief: join(path, '.gho', 'brief.md') };
  }
  private async branchConfig(branch: string, key: string): Promise<string | null> {
    try { return await this.git(['config', '--local', '--get', `branch.${branch}.${key}`]); }
    catch (error) { if (error instanceof CommandError && error.code === 1) return null; throw error; }
  }
  /** Only the scheduler's persisted provisioning intent should call this recovery operation. */
  async recover(number: number, title: string): Promise<Created | null> {
    const branch = branchName(this.config, number), path = (await this.worktrees()).get(branch); if (!path) return null;
    const root = (await this.runner.run({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd: path })).trim();
    const current = (await this.runner.run({ argv: ['git', 'branch', '--show-current'], cwd: path })).trim();
    ensure(await realpath(root) === await realpath(path) && current === branch, 'Worktree identity changed or checkout is missing; refusing recovery.');
    const directory = join(path, '.gho'), brief = join(directory, 'brief.md');
    for (const candidate of [directory, brief, join(directory, '.gitignore')]) {
      try { ensure(!(await lstat(candidate)).isSymbolicLink(), `Refusing symlink in recovery path: ${candidate}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    let existing: string | null = null; try { existing = await readFile(brief, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const markerIssue = await this.branchConfig(branch, 'ghoIssue'), markerRepo = await this.branchConfig(branch, 'ghoRepo');
    const owned = markerIssue === String(number) && markerRepo?.toLowerCase() === this.config.repo.toLowerCase();
    let briefBase: string | undefined;
    if (existing !== null) {
      const url = issueUrl(issueRef(this.config.repo, number));
      const baseLines = [...existing.matchAll(/^- Base branch: `([^`\r\n]+)`\. The pull request targets this branch\.$/gm)];
      ensure(existing.startsWith(`# Issue #${number}: `) && existing.split('\n').includes(`- Issue: ${url}`) && existing.split('\n').includes(`- Branch: \`${branch}\`, checked out in this worktree.`) && existing.split('\n').includes(`gh issue view ${number} --repo ${this.config.repo} --comments`) && baseLines.length === 1, `Existing worktree brief does not identify ${this.config.repo}#${number}; refusing recovery.`);
      briefBase = baseLines[0]![1];
    } else ensure(owned, `Existing worktree ${path} has no matching gho provisioning marker or task brief; refusing recovery.`);
    if (markerIssue !== null || markerRepo !== null) ensure(owned, 'Worktree provisioning identity mismatch; refusing recovery.');
    const merge = await this.branchConfig(branch, 'merge');
    const base_branch = await this.branchConfig(branch, 'ghoBaseBranch') ?? briefBase ?? (merge?.startsWith('refs/heads/') ? merge.slice(11) : null);
    ensure(base_branch && !base_branch.startsWith('-') && !/[\0\r\n]/.test(base_branch), 'Cannot recover the worktree base branch safely.');
    if (briefBase) ensure(base_branch === briefBase, 'Task brief and provisioning base branch disagree.');
    const base = await this.branchConfig(branch, 'ghoBase') ?? `origin/${base_branch}`;
    const base_commit = await this.branchConfig(branch, 'ghoBaseCommit') ?? await this.git(['merge-base', branch, base]);
    const created = { issue: number, branch, path, base, base_branch, base_commit, brief };
    if (existing === null) {
      // A tracked .gho directory belongs to the repository, even if provisioning owns the branch.
      const tracked = await this.runner.run({ argv: ['git', 'ls-files', '--', '.gho'], cwd: path }); ensure(!tracked.trim(), 'Refusing to replace tracked .gho files during recovery.');
      await mkdir(directory, { recursive: true });
      const ignore = join(directory, '.gitignore');
      try { await writeFile(ignore, '*\n', { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; ensure(await readFile(ignore, 'utf8') === '*\n', 'Existing .gho/.gitignore is not owned by gho.'); }
      await writeFile(brief, await renderBrief({ number, title, url: issueUrl(issueRef(this.config.repo, number)), repo: this.config.repo, branch, base_branch }), { flag: 'wx' });
    }
    return created;
  }
  async writeBrief(created: Created, title: string): Promise<void> {
    try {
      const brief = await renderBrief({ number: created.issue, title, url: issueUrl(issueRef(this.config.repo, created.issue)), repo: this.config.repo, branch: created.branch, base_branch: created.base_branch });
      const directory = join(created.path, '.gho'); await mkdir(directory); await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx' }); await writeFile(created.brief, brief, { flag: 'wx' });
    } catch (error) { throw new Error(`Created the worktree at ${created.path}, but not its brief: ${String(error)}`); }
  }
}
