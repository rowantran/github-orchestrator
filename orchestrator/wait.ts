import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { descriptor, type ServiceDescriptor } from './service.js';
import type { AgentStatus, Role, Run } from './types.js';

const roles: readonly Role[] = ['implementer', 'reviewer'];
const statuses = new Set<AgentStatus>(['idle', 'starting', 'working', 'settled', 'prompting', 'exited']);
const settledStatuses = new Set<AgentStatus>(['settled', 'prompting', 'exited']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentTarget { issue: number; role?: Role }
export interface WatchedAgent {
  id: string;
  issue: number;
  role: Role;
  status: Exclude<AgentStatus, 'idle'>;
  sessionId: string;
  settlement?: string;
  new: boolean;
}
export interface AgentWaitOptions {
  targets?: readonly string[];
  since?: string;
  all?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
}
export interface AgentObservation { settled: boolean; cursor: string; agents: WatchedAgent[] }
export interface AgentWaitResult { result: 'settled' | 'timeout'; cursor: string; agents: WatchedAgent[] }

export function parseAgentTargets(values: readonly string[]): AgentTarget[] {
  const targets = new Map<string, AgentTarget>();
  for (const value of values) {
    const match = /^([1-9]\d*)(?:\/(implementer|reviewer))?$/.exec(value);
    const issue = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(issue)) throw new Error(`Invalid agent target ${JSON.stringify(value)}. Use an issue number or ISSUE/implementer or ISSUE/reviewer.`);
    targets.set(value, { issue, ...(match[2] ? { role: match[2] as Role } : {}) });
  }
  return [...targets.values()].sort((a, b) => a.issue - b.issue || (a.role ?? '').localeCompare(b.role ?? ''));
}

/** Cursors contain only stable role-specific settlement IDs, never a run timestamp. */
export function parseAgentCursor(value?: string): Map<string, string> {
  if (value === undefined || value === 'start') return new Map();
  const invalid = () => new Error('Invalid agent cursor. Pass start or the cursor printed by gho wait agents (an object mapping ISSUE/role to settlement UUID).');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const cursor = new Map<string, string>();
  for (const [key, settlement] of Object.entries(parsed)) {
    let target: AgentTarget | undefined;
    try { target = parseAgentTargets([key])[0]; } catch { throw invalid(); }
    if (!target?.role || typeof settlement !== 'string' || !uuid.test(settlement)) throw invalid();
    cursor.set(key, settlement);
  }
  return cursor;
}

function encodeCursor(cursor: ReadonlyMap<string, string>): string {
  if (!cursor.size) return 'start';
  return JSON.stringify(Object.fromEntries([...cursor].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))));
}

function observe(runs: readonly Run[], targets: readonly AgentTarget[], since: ReadonlyMap<string, string>, all: boolean): AgentObservation {
  const agents: WatchedAgent[] = [];
  const identities = new Set<string>();
  for (const run of runs) {
    if (!Number.isSafeInteger(run.issue) || run.issue < 1) throw new Error('The service returned an invalid issue number.');
    for (const role of roles) {
      if (targets.length && !targets.some(target => target.issue === run.issue && (!target.role || target.role === role))) continue;
      const record = run.agents?.[role];
      if (!record || !statuses.has(record.status)) throw new Error(`The service returned an invalid agent status for ${run.issue}/${role}.`);
      if (record.status === 'idle') continue; // A preallocated session ID is not proof that an agent started.
      const id = `${run.issue}/${role}`;
      if (identities.has(id)) throw new Error(`The service returned duplicate agent ${id}.`);
      identities.add(id);
      if (typeof record.sessionId !== 'string' || !record.sessionId) throw new Error(`The service returned an invalid session for ${id}.`);
      if (record.settlement !== undefined && !uuid.test(record.settlement)) throw new Error(`The service returned an invalid settlement UUID for ${id}.`);
      agents.push({
        id, issue: run.issue, role, status: record.status, sessionId: record.sessionId,
        ...(record.settlement ? { settlement: record.settlement } : {}),
        // Old records without a settlement ID cannot supply evidence of a new settlement.
        new: settledStatuses.has(record.status) && record.settlement !== undefined && since.get(id) !== record.settlement,
      });
    }
  }
  agents.sort((a, b) => a.issue - b.issue || a.role.localeCompare(b.role));
  const missingTarget = targets.some(target => !agents.some(agent => agent.issue === target.issue && (!target.role || agent.role === target.role)));
  const settled = agents.some(agent => agent.new) && (!all || (!missingTarget && agents.every(agent => settledStatuses.has(agent.status))));
  const cursor = new Map(since);
  // A timeout does not consume a settlement observed while --all was still waiting.
  if (settled) for (const agent of agents) if (settledStatuses.has(agent.status) && agent.settlement) cursor.set(agent.id, agent.settlement);
  return { settled, cursor: encodeCursor(cursor), agents };
}

/** Pure observation helper for callers that already have a local run snapshot. */
export function observeAgents(runs: readonly Run[], options: Pick<AgentWaitOptions, 'targets' | 'since' | 'all'> = {}): AgentObservation {
  return observe(runs, parseAgentTargets(options.targets ?? []), parseAgentCursor(options.since), options.all ?? false);
}

function duration(value: number | undefined, fallback: number, minimum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`${name} must be a ${minimum ? 'positive' : 'nonnegative'} integer in milliseconds.`);
  return result;
}

/** Read local state only. Validation occurs before the first service request. */
export async function waitForAgents(readRuns: () => Promise<Run[]>, options: AgentWaitOptions = {}): Promise<AgentWaitResult> {
  const targets = parseAgentTargets(options.targets ?? []), since = parseAgentCursor(options.since);
  const interval = duration(options.intervalMs, 2_000, 1, 'intervalMs');
  const timeout = options.timeoutMs === undefined ? undefined : duration(options.timeoutMs, 0, 0, 'timeoutMs');
  const start = performance.now();
  while (true) {
    const observation = observe(await readRuns(), targets, since, options.all ?? false);
    if (observation.settled) return { result: 'settled', cursor: observation.cursor, agents: observation.agents };
    const remaining = timeout === undefined ? undefined : timeout - (performance.now() - start);
    if (remaining !== undefined && remaining <= 0) return { result: 'timeout', cursor: observation.cursor, agents: observation.agents };
    await sleep(remaining === undefined ? interval : Math.min(interval, remaining));
  }
}

export interface StopOptions { timeoutMs?: number; intervalMs?: number }
type Owner = Pick<ServiceDescriptor, 'pid' | 'token'>;
interface Lock { pid: number; nonce: string }

async function readLock(root: string): Promise<Lock | null> {
  let text: string;
  try { text = await readFile(join(root, 'service.lock'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Service lock is unreadable. It was not removed; check the service log.'); }
  const lock = value as Partial<Lock> | null;
  if (!lock || !Number.isSafeInteger(lock.pid) || (lock.pid ?? 0) < 1 || typeof lock.nonce !== 'string' || !lock.nonce) throw new Error('Service lock is invalid. It was not removed; check the service log.');
  return lock as Lock;
}

/** A failed health request never proves shutdown: both owner files must be released. */
export async function waitForServiceStop(root: string, expected: Owner | null, options: StopOptions = {}): Promise<void> {
  const timeout = duration(options.timeoutMs, 30_000, 0, 'timeoutMs'), interval = duration(options.intervalMs, 100, 1, 'intervalMs');
  const deadline = performance.now() + timeout;
  let lockNonce: string | undefined;
  while (true) {
    const [current, lock] = await Promise.all([descriptor(root), readLock(root)]);
    if (current && (!expected || current.pid !== expected.pid || current.token !== expected.token)) throw new Error('Service ownership changed during shutdown. The replacement service was not stopped.');
    if (lock && expected && lock.pid !== expected.pid) throw new Error('Service lock belongs to a different process. It was not removed or stopped.');
    if (lockNonce && lock && lock.nonce !== lockNonce) throw new Error('Service lock changed during shutdown. The replacement service was not stopped.');
    lockNonce ??= lock?.nonce;
    if (!current && !lock) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('Service is still stopping: its descriptor or lock remains after the shutdown deadline. Check the service log before retrying; no process was killed.');
    await sleep(Math.min(interval, remaining));
  }
}

/** Authenticate the selected descriptor, request shutdown, then wait for durable ownership release. */
export async function stopService(root: string, expected: ServiceDescriptor | null, options: StopOptions = {}): Promise<void> {
  const timeout = duration(options.timeoutMs, 30_000, 0, 'timeoutMs');
  const deadline = performance.now() + timeout;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  if (expected && remaining() > 0) {
    const current = await descriptor(root);
    if (current && (current.pid !== expected.pid || current.token !== expected.token)) throw new Error('Service ownership changed before shutdown. The replacement service was not stopped.');
    if (current) {
      const request = (path: string, post: boolean, budget: number) => fetch(`http://127.0.0.1:${expected.port}${path}`, {
        method: post ? 'POST' : 'GET', headers: { 'x-gho-token': expected.token, ...(post ? { 'content-type': 'application/json' } : {}) },
        ...(post ? { body: '{}' } : {}), signal: AbortSignal.timeout(Math.max(1, budget)),
      });
      let healthy = false;
      try {
        const health = await request('/api/health', false, Math.min(2_000, remaining()));
        if (health.ok) healthy = (await health.json() as { ok?: unknown }).ok === true;
        else await health.body?.cancel();
      } catch { /* The HTTP listener may already be closing. Owner files remain the shutdown evidence. */ }
      if (healthy && remaining() > 0) {
        const latest = await descriptor(root);
        if (latest && (latest.pid !== expected.pid || latest.token !== expected.token)) throw new Error('Service ownership changed before shutdown. The replacement service was not stopped.');
        if (latest) {
          let response: Response | undefined;
          try { response = await request('/api/shutdown', true, remaining()); }
          catch { /* A lost acknowledgement is not proof of failure or completion; check owner files. */ }
          if (response && !response.ok) {
            let reason = `HTTP ${response.status}`;
            try { reason = String((await response.json() as { error?: unknown }).error ?? reason); } catch { /* Keep the HTTP status if the body is unreadable. */ }
            throw new Error(`Service rejected shutdown: ${reason}`);
          }
          await response?.body?.cancel();
        }
      }
    }
  }
  await waitForServiceStop(root, expected, { ...options, timeoutMs: remaining() });
}
