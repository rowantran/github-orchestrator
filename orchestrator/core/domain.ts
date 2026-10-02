import { createHash } from 'node:crypto';
import type { Config, Issue, IssueRef, LinkedPullRequest, PullRequest } from './types.js';
export function ensure(condition: unknown, detail: string): asserts condition { if (!condition) throw new Error(detail); }
export function validateRepo(repo: string): string {
  ensure(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && repo.split('/').every(p => p !== '.' && p !== '..'), 'Repository must be OWNER/REPO on github.com.');
  return repo.toLowerCase();
}
export function issueRef(repo: string, number: number): IssueRef {
  ensure(Number.isSafeInteger(number) && number > 0, 'Issue number must be a positive safe integer.');
  return { repo: validateRepo(repo), number };
}
export function parseIssue(value: string | number, repo?: string): IssueRef {
  const text = String(value), match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/*$/.exec(text);
  if (match) return issueRef(match[1]!, Number(match[2]));
  if (repo && /^#?[0-9]+$/.test(text)) return issueRef(repo, Number(text.replace(/^#/, '')));
  throw new Error('Use an issue number or a full https://github.com/OWNER/REPO/issues/N URL.');
}
export const issueKey = (r: IssueRef): string => `${r.repo.toLowerCase()}#${r.number}`;
export const issueUrl = (r: IssueRef): string => `https://github.com/${r.repo.toLowerCase()}/issues/${r.number}`;
export const branchName = (config: Config, number: number): string => `${config.owner}/gh-${issueRef(config.repo, number).number}`;
export const completed = (issue: Issue): boolean => issue.state === 'CLOSED' && issue.state_reason === 'COMPLETED';
export const linked = (pr: PullRequest): LinkedPullRequest => ({ url: pr.url, state: pr.state, draft: pr.draft, head: pr.head, base: pr.base });
export const digest = (urls: string[]): string => createHash('sha256').update(JSON.stringify(urls)).digest('hex');
export function metadata(condition: unknown, detail: string): asserts condition { ensure(condition, `Missing, inaccessible, or inconsistent GitHub metadata: ${detail}`); }
export type JsonObject = Record<string, unknown>;
export function object(value: unknown, detail = 'object'): JsonObject { metadata(value !== null && typeof value === 'object' && !Array.isArray(value), detail); return value as JsonObject; }
export function array(value: unknown, detail = 'array'): unknown[] { metadata(Array.isArray(value), detail); return value; }
export function text(value: unknown, detail = 'text', blank = false): string { metadata(typeof value === 'string' && (blank || value.trim().length > 0), detail); return value; }
export function integer(value: unknown, detail = 'integer', min = 0): number { metadata(typeof value === 'number' && Number.isSafeInteger(value) && value >= min, detail); return value; }
export function boolean(value: unknown, detail = 'boolean'): boolean { metadata(typeof value === 'boolean', detail); return value; }
export function oneOf<T extends string>(value: unknown, values: readonly T[], detail: string): T { metadata(typeof value === 'string' && values.includes(value as T), detail); return value as T; }
export function nullableText(value: unknown, detail: string): string | null { return value === null ? null : text(value, detail); }
export function uniqueLabels(values: string[]): string[] {
  metadata(new Set(values.map(v => v.toLowerCase())).size === values.length, 'duplicate label name'); return values.sort();
}
export const WORKSTREAM_PREFIX = 'gho:workstream:';
export function workstreamLabel(name: string): string {
  ensure(typeof name === 'string' && name.length > 0 && WORKSTREAM_PREFIX.length + name.length <= 50 && name.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)), 'Invalid workstream name. Use slash-separated alphanumeric names with . _ -, at most 35 characters.');
  return WORKSTREAM_PREFIX + name;
}
export function workstreamNames(labels: string[]): string[] {
  return [...new Set(labels.filter(l => l.toLowerCase().startsWith(WORKSTREAM_PREFIX)).map(l => { const name = l.slice(WORKSTREAM_PREFIX.length); workstreamLabel(name); return name; }))].sort();
}
