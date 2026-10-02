import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import type { Agents, Config, OrchestrationConfig } from './types.js';
import { ensure, validateRepo } from './domain.js';
import { CommandError, systemRunner, type Runner } from './process.js';

export function expandUser(path: string): string { return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path; }
export async function resolvePath(path: string): Promise<string> {
  const absolute = resolve(expandUser(path));
  try { return await realpath(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute); if (parent === absolute) throw error;
    return join(await resolvePath(parent), absolute.slice(parent.length));
  }
}
export function configDirectory(dir?: string): string { return expandUser(dir ?? process.env.GHO_CONFIG_DIR ?? '~/.config/github-orchestrator'); }
export function githubRemoteRepo(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? validateRepo(match[1]!) : null;
}
export async function locate(cwd: string, runner: Runner = systemRunner): Promise<{ checkout: string; repo: string } | null> {
  let checkout: string;
  try { checkout = await realpath((await runner.run({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd })).trim()); }
  catch (error) { if (error instanceof CommandError && error.code === 128) return null; throw error; }
  let origin: string;
  try { origin = (await runner.run({ argv: ['git', 'remote', 'get-url', 'origin'], cwd: checkout })).trim(); }
  catch { throw new Error(`The checkout ${checkout} has no origin remote.`); }
  const repo = githubRemoteRepo(origin);
  ensure(repo, `The origin of ${checkout} is not a github.com repository: ${origin}`);
  return { checkout, repo };
}
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
export const validBranch = (branch: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..');
function keys(value: Record<string, unknown>, allowed: string[]): void { for (const key of Object.keys(value)) ensure(allowed.includes(key), `Unknown config key: ${key}`); }
function table(value: unknown, label: string): Record<string, unknown> { ensure(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a table.`); return value as Record<string, unknown>; }
function string(value: unknown, label: string): string { ensure(typeof value === 'string', `${label} must be a string.`); return value; }
async function readConfig(path: string): Promise<Record<string, unknown>> {
  try { return parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot load config ${path}: ${String(error)}. Run gho init if missing.`); }
}
export async function loadConfig(cwd: string, configDir?: string, runner: Runner = systemRunner): Promise<Config> {
  const location = await locate(cwd, runner); ensure(location, 'Run gho inside a checkout of a GitHub repository.');
  const dir = await resolvePath(resolve(cwd, configDirectory(configDir)));
  const global = await readConfig(join(dir, 'config.toml')), local = await readConfig(join(dir, 'repos', `${location.repo}.toml`));
  keys(global, ['owner', 'agents', 'obsidian', 'orchestration']); keys(local, ['project_url', 'base_branch', 'orchestration']);
  const owner = string(global.owner, 'owner'); ensure(ownerPattern.test(owner), 'owner must be a GitHub login.');
  const agents = table(global.agents ?? {}, 'agents'); keys(agents, ['runtime', 'planner_model', 'implementer_model', 'reviewer_model']);
  for (const [key, value] of Object.entries(agents)) {
    if (key === 'runtime') ensure(value === 'durable' || value === 'rpc', 'agents.runtime must be "durable" or "rpc".');
    else ensure(modelPattern.test(string(value, `agents.${key}`)), `agents.${key} must be a Pi model pattern.`);
  }
  const project_url = string(local.project_url, 'project_url');
  ensure(/^https:\/\/github\.com\/(?:users|orgs)\/[A-Za-z0-9-]+\/projects\/[1-9][0-9]*\/?$/.test(project_url), 'Fill in project_url with a github.com user or organization Project URL.');
  const base_branch = string(local.base_branch ?? 'main', 'base_branch'); ensure(validBranch(base_branch), 'Invalid base_branch.');
  const obsidian = table(global.obsidian ?? {}, 'obsidian'); keys(obsidian, ['vault']);
  const vault = obsidian.vault === undefined ? '' : string(obsidian.vault, 'obsidian.vault');
  const orchestration = { ...table(global.orchestration ?? {}, 'orchestration'), ...table(local.orchestration ?? {}, 'orchestration') };
  keys(orchestration, ['max_concurrency', 'poll_interval_ms', 'agent_timeout_ms', 'max_attempts', 'max_review_rounds']);
  for (const [key, value] of Object.entries(orchestration)) ensure(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, `orchestration.${key} must be a positive integer.`);
  return { ...location, owner, project_url, base_branch, vault: vault ? await resolvePath(resolve(cwd, expandUser(vault))) : null, agents: agents as Agents, ...(Object.keys(orchestration).length ? { orchestration: orchestration as OrchestrationConfig } : {}) };
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export interface InitializedConfig { files: { path: string; created: boolean }[]; repo: string | null }
export async function initConfig(cwd: string, configDir?: string, runner: Runner = systemRunner): Promise<InitializedConfig> {
  const dir = await resolvePath(resolve(cwd, configDirectory(configDir))), files: { path: string; content?: string }[] = [];
  const global = join(dir, 'config.toml');
  if (await exists(global)) files.push({ path: global });
  else {
    const owner = (await runner.run({ argv: ['gh', 'api', '--hostname', 'github.com', 'user', '--jq', '.login'], env: { GH_HOST: 'github.com' }, cwd })).trim();
    ensure(ownerPattern.test(owner), 'owner must be a GitHub login.');
    files.push({ path: global, content: `owner = ${JSON.stringify(owner)}\n\n[agents]\n# runtime = "durable"  # or "rpc" for full Pi CLI workers\n# planner_model = "provider/model"\n# implementer_model = "provider/model"\n# reviewer_model = "provider/model"\n\n[obsidian]\n# vault = "/path/to/vault"\n` });
  }
  const location = await locate(cwd, runner);
  if (location) {
    const path = join(dir, 'repos', `${location.repo}.toml`);
    if (await exists(path)) files.push({ path });
    else {
      let base = 'main';
      try { const head = (await runner.run({ argv: ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd: location.checkout })).trim(); if (head.startsWith('origin/')) base = head.slice(7); } catch { /* No recorded remote HEAD. */ }
      ensure(validBranch(base), 'Invalid base branch.');
      files.push({ path, content: `project_url = ""\nbase_branch = ${JSON.stringify(base)}\n` });
    }
  }
  const result: InitializedConfig = { files: [], repo: location?.repo ?? null };
  for (const file of files) {
    let created = false;
    if (file.content !== undefined) { await mkdir(dirname(file.path), { recursive: true }); try { await writeFile(file.path, file.content, { flag: 'wx' }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    result.files.push({ path: file.path, created });
  }
  return result;
}
