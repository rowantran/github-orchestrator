import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Run, Role } from './types.js';

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
    // Sync the name replacement as well as the contents before acknowledging a checkpoint.
    await syncDirectory(dirname(path));
  } finally { await rm(temp, { force: true }); }
}

const phases = new Set(['queued', 'planning', 'awaiting_approval', 'implementing', 'reviewing', 'ready_to_merge', 'paused', 'blocked', 'done', 'closed']);
export class RunStore {
  constructor(readonly root: string) {}
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'executions'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'events'), { recursive: true, mode: 0o700 });
  }
  async load(): Promise<Run[]> {
    await this.initialize();
    const runs: Run[] = [];
    for (const name of await readdir(join(this.root, 'executions'))) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.root, 'executions', name);
      const run = JSON.parse(await readFile(path, 'utf8')) as Run;
      if (run.version !== 1 || !Number.isSafeInteger(run.issue) || run.issue < 1 || name !== `${run.issue}.json` ||
          typeof run.repo !== 'string' || !phases.has(run.phase) || !['supervised','unsupervised'].includes(run.mode) ||
          !run.agents?.implementer?.sessionId || !run.agents?.reviewer?.sessionId || !Array.isArray(run.seenFeedback)) {
        throw new Error(`Invalid execution checkpoint: ${path}. Restore it before starting the service.`);
      }
      runs.push(run);
    }
    return runs.sort((a, b) => a.issue - b.issue);
  }
  async save(run: Run): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await atomicJson(join(this.root, 'executions', `${run.issue}.json`), run);
  }
  eventPath(issue: number, role: Role): string { return join(this.root, 'events', `${issue}-${role}.jsonl`); }
  async appendEvent(issue: number, role: Role, event: Record<string, unknown>): Promise<void> {
    const file = await open(this.eventPath(issue, role), 'a', 0o600);
    try { await file.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); }
    finally { await file.close(); }
  }
  async events(issue: number, role: Role): Promise<Record<string, unknown>[]> {
    // A bounded tail keeps a large tool log from exhausting a dashboard request.
    let file;
    try { file = await open(this.eventPath(issue, role), 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - 2 * 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start) lines.shift();
      return lines.filter(Boolean).slice(-1000).flatMap(line => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
    } finally { await file.close(); }
  }
}

async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return undefined; }
}
export async function processAlive(pid: number, identity?: string): Promise<boolean> {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  return !identity || await processIdentity(pid) === identity;
}

/**
 * flock(2) locks the shared open-file description, not the short-lived helper process.
 * fd 3 is a duplicate of Node's descriptor: the lock survives helper exit and is released
 * when Node closes its descriptor, including SIGKILL. No helper or stale-lock polling remains.
 * Requires util-linux flock on Linux, or `brew install flock` on macOS. Other platforms
 * fail closed rather than falling back to a stale-file takeover protocol.
 */
async function lockDescriptor(fd: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('flock', ['-n', '-E', '200', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => { stderr = (stderr + text).slice(-4096); });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(new Error('Cannot acquire service ownership. Install flock on PATH (Linux: util-linux; macOS: brew install flock).', { cause: error }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else if (code === 200) reject(new Error('Orchestration service is already running (kernel lock is held).'));
      else reject(new Error(`Cannot acquire service ownership: flock ${signal ?? `exited ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}.`));
    });
  });
}

export type OwnedLock = (() => Promise<void>) & { readonly fd: number };

/** One owner for all execution checkpoints and Pi session writers in this checkout. */
export async function acquireLock(root: string): Promise<OwnedLock> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('OS-held service locks require Linux or macOS with flock installed.');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  // This inode is permanent. Never unlink or atomically replace it: doing so splits ownership.
  // service.lock is only readable metadata; stale or partial metadata never authorizes takeover.
  const guard = await open(join(root, 'service.guard'), 'a+', 0o600);
  const path = join(root, 'service.lock');
  try {
    await lockDescriptor(guard.fd);
    await atomicJson(path, { pid: process.pid, identity: await processIdentity(process.pid), nonce: randomUUID() });
  } catch (error) {
    await guard.close();
    throw error;
  }
  let releasing: Promise<void> | undefined;
  const release = () => releasing ??= (async () => {
    try {
      // Remove metadata before unlocking, so a former owner cannot delete its successor's file.
      await rm(path, { force: true });
      await syncDirectory(root);
    } finally { await guard.close(); }
  })();
  return Object.assign(release, { fd: guard.fd });
}
