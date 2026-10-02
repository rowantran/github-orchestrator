import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Core, type Config } from './core/index.js';
import { Orchestrator } from './engine.js';
import { startServer, type DashboardServer, type ServiceAPI } from './http.js';
import { createAgentFactory } from './agents/index.js';
import { acquireLock, atomicJson, RunStore } from './store.js';

const exec = promisify(execFile);
export interface ServiceDescriptor { pid: number; url: string; port: number; token: string; repo: string; createdAt: string; }
export interface ServiceOptions { port?: number; tailscaleServe?: boolean; configDir?: string; }
export async function runtimeDirectory(cwd: string): Promise<string> {
  const result = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 15_000 });
  return join(resolve(cwd, result.stdout.trim()), 'gho-service');
}
export async function descriptor(root: string): Promise<ServiceDescriptor | null> {
  try {
    const value = JSON.parse(await readFile(join(root, 'service.json'), 'utf8')) as ServiceDescriptor;
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== 'string' || !value.token) throw new Error('Invalid service descriptor.');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function serviceRequest<T = unknown>(service: ServiceDescriptor, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-gho-token': service.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(100_000),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Service returned HTTP ${response.status}`);
  return value;
}
export async function findService(root: string, repo: string): Promise<ServiceDescriptor | null> {
  const value = await descriptor(root);
  if (!value) return null;
  if (value.repo !== repo) throw new Error('Service belongs to a different repository.');
  try {
    const response = await fetch(`http://127.0.0.1:${value.port}/api/health`, { headers: { 'x-gho-token': value.token }, signal: AbortSignal.timeout(2000) });
    if (response.ok) return value;
  } catch { /* A stale descriptor is not an active daemon. */ }
  return null;
}
export async function ensureService(config: Config, options: ServiceOptions = {}): Promise<ServiceDescriptor> {
  const root = await runtimeDirectory(config.checkout);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const existing = await findService(root, config.repo);
  if (existing) return existing;
  const args = [fileURLToPath(new URL('../../bin/gho.mjs', import.meta.url)), 'serve'];
  if (options.configDir) args.push('--config-dir', resolve(options.configDir));
  if (options.port !== undefined) args.push('--port', String(options.port));
  if (options.tailscaleServe) args.push('--tailscale-serve');
  const log = await open(join(root, 'service.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, args, { cwd: config.checkout, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
  } finally { await log.close(); }
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.unref();
  for (let n = 0; n < 200; n++) {
    if (spawnError) throw spawnError;
    const running = await findService(root, config.repo);
    if (running) return running;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`Service did not start. Read ${join(root, 'service.log')}.`);
}

export async function serve(config: Config, options: ServiceOptions = {}): Promise<void> {
  const root = await runtimeDirectory(config.checkout);
  const unlock = await acquireLock(root);
  const settings = config.orchestration;
  const engine = new Orchestrator(new Core(config), new RunStore(root),
    await createAgentFactory(config.agents.runtime, config.checkout, message => console.error(`gho service: ${message}`)), {
    concurrency: settings?.max_concurrency,
    pollMs: settings?.poll_interval_ms,
    runTimeoutMs: settings?.agent_timeout_ms,
    maxAttempts: settings?.max_attempts,
    maxReviewRounds: settings?.max_review_rounds,
    onError: error => console.error(`gho service: ${error instanceof Error ? error.message : String(error)}`),
  });
  let server: DashboardServer | undefined;
  let stopped = false;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    try {
      const results = await Promise.allSettled([engine.close(), server?.close()]);
      for (const result of results) if (result.status === 'rejected') console.error('Shutdown error:', result.reason);
    } finally {
      const saved = await descriptor(root);
      if (saved?.pid === process.pid) await rm(join(root, 'service.json'), { force: true });
      await unlock(); finish();
    }
  };
  const signal = () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; finish(); }); };
  try {
    await engine.initialize();
    const api: ServiceAPI = {
      shutdown, snapshot: () => engine.snapshot(), runs: () => engine.runs(), getRun: issue => engine.getRun(issue),
      start: (issue, opts) => engine.start(issue, opts),
      approve: (issue, sha, actor) => engine.approve(issue, sha, actor ?? 'dashboard', actor === 'cli' ? 'cli' : 'dashboard'),
      pause: issue => engine.pause(issue), resume: issue => engine.resume(issue),
      message: (issue, role, text) => engine.message(issue, role, text), agent: (issue, role) => engine.agent(issue, role),
      respond: (issue, role, response) => engine.respond(issue, role, response as Record<string, unknown>),
    };
    server = await startServer(api, options);
    await atomicJson(join(root, 'service.json'), { pid: process.pid, url: server.url, port: server.port, token: server.token, repo: config.repo, createdAt: new Date().toISOString() } satisfies ServiceDescriptor);
    process.once('SIGINT', signal); process.once('SIGTERM', signal);
    console.log(server.url);
    engine.begin();
    await done;
  } catch (error) { await shutdown(); throw error; }
  finally { process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); }
}
