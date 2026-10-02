import type { Feedback, PullRequestInfo } from '../types.js';
import type { SubmittedReview, ReviewComment, HumanComment } from './types.js';
import { array, boolean, branchName, ensure, integer, metadata, object, oneOf, text, type JsonObject } from './domain.js';
import { GitHub, onlyOpen } from './github.js';

export const agentText = (body: string): boolean => body.trimStart().startsWith('[agent:]');
const bodyText = (value: unknown): string => value == null ? '' : text(value, 'feedback body', true);
export function byAgent(review: JsonObject, comments: JsonObject[]): boolean {
  const body = bodyText(review.body); return body.trim() ? agentText(body) : comments.length > 0 && comments.every(comment => agentText(bodyText(comment.body)));
}
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
function date(value: unknown): string { const result = text(value, 'feedback timestamp'); metadata(validDate(result), 'feedback timestamp'); return result; }
function author(value: unknown): string | null { return value === null ? null : text(object(value, 'feedback user').login, 'feedback author'); }
function reviewComment(comment: JsonObject): ReviewComment {
  const line = comment.line == null ? null : integer(comment.line, 'comment line', 1);
  return { id: integer(comment.id, 'comment ID', 1), url: text(comment.html_url, 'comment URL'), path: text(comment.path, 'comment path'), line: line ?? (comment.original_line == null ? null : integer(comment.original_line, 'original line', 1)), outdated: line === null, in_reply_to: comment.in_reply_to_id == null ? null : integer(comment.in_reply_to_id, 'reply ID', 1), body: bodyText(comment.body) };
}
export function submittedReviews(reviews: JsonObject[], comments: JsonObject[]): SubmittedReview[] {
  const seen = new Set<number>(), result: SubmittedReview[] = [];
  for (const review of reviews) {
    const id = integer(review.id, 'review ID', 1); metadata(!seen.has(id), 'duplicate review'); seen.add(id);
    const state = text(review.state, 'review state');
    if (review.submitted_at == null || !['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'].includes(state)) continue;
    const grouped = comments.filter(c => c.pull_request_review_id === id); if (byAgent(review, grouped)) continue;
    result.push({ id, url: text(review.html_url, 'review URL'), author: author(review.user), state, submitted_at: date(review.submitted_at), body: bodyText(review.body), comments: grouped.map(reviewComment) });
  }
  return result.sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id);
}
export function humanComments(comments: JsonObject[]): HumanComment[] {
  const ids = new Set<number>();
  return comments.map(c => {
    const id = integer(c.id, 'comment ID', 1); metadata(!ids.has(id), 'duplicate comment'); ids.add(id);
    return { id, url: text(c.html_url, 'comment URL'), author: author(c.user), body: bodyText(c.body), created_at: date(c.created_at), updated_at: date(c.updated_at) };
  }).filter(c => !agentText(c.body));
}
export class ReviewCursor {
  private at: number | null = null;
  private ids = new Set<number>();
  constructor(value = 'start') {
    if (value === 'start') return;
    const [at, ...ids] = value.split(',');
    ensure(at && validDate(at) && ids.length > 0 && ids.every(id => /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))), 'Invalid review cursor.');
    this.at = Date.parse(at); this.ids = new Set(ids.map(Number));
  }
  covers(at: string, id: number): boolean { const time = Date.parse(date(at)); return this.at !== null && (time < this.at || time === this.at && this.ids.has(id)); }
  advance(at: string, id: number): void { const time = Date.parse(date(at)); if (this.at === null || time > this.at) { this.at = time; this.ids = new Set([id]); } else if (time === this.at) this.ids.add(id); }
  toString(): string { return this.at === null ? 'start' : `${new Date(this.at).toISOString().replace('.000Z', 'Z')},${[...this.ids].sort((a, b) => a - b).join(',')}`; }
}
export async function readReviews(github: GitHub, number: number): Promise<{ reviews: JsonObject[]; comments: JsonObject[] }> {
  return { reviews: await github.restPages(`repos/${github.config.repo}/pulls/${number}/reviews?per_page=100`), comments: await github.restPages(`repos/${github.config.repo}/pulls/${number}/comments?per_page=100`) };
}
export async function checkReviews(github: GitHub, number: number, since = 'start'): Promise<{ result: 'reviews' | 'merged' | 'closed' | 'waiting'; pull_request: { number: number; url: string; draft: boolean }; reviews: SubmittedReview[]; cursor: string }> {
  const cursor = new ReviewCursor(since), status = await pullRequestStatus(github, number);
  const pull_request = { number, url: text(status.html_url), draft: boolean(status.draft) };
  if (status.merged || status.state === 'closed') return { result: status.merged ? 'merged' : 'closed', pull_request, reviews: [], cursor: cursor.toString() };
  const raw = await readReviews(github, number), reviews = submittedReviews(raw.reviews, raw.comments).filter(r => !cursor.covers(r.submitted_at, r.id));
  for (const review of reviews) cursor.advance(review.submitted_at, review.id);
  return { result: reviews.length ? 'reviews' : 'waiting', pull_request, reviews, cursor: cursor.toString() };
}
export async function pullRequestStatus(github: GitHub, number: number): Promise<JsonObject> {
  const status = object(await github.api(`repos/${github.config.repo}/pulls/${number}`), 'pull request');
  metadata(integer(status.number, 'PR number', 1) === number, 'pull request number');
  metadata(text(status.html_url, 'PR URL').toLowerCase() === `https://github.com/${github.config.repo}/pull/${number}`.toLowerCase(), 'pull request URL');
  oneOf(status.state, ['open', 'closed'] as const, 'PR state'); boolean(status.merged, 'merged'); boolean(status.draft, 'draft');
  metadata(!status.merged || status.state === 'closed', 'merged PR state'); return status;
}
async function checks(github: GitHub, sha: string): Promise<PullRequestInfo['checks']> {
  const checkPages = array(await github.api(`repos/${github.config.repo}/commits/${sha}/check-runs?per_page=100&filter=latest`, ['--paginate', '--slurp']), 'check pages');
  metadata(checkPages.length > 0, 'check pages');
  let total: number | undefined; const runs: JsonObject[] = [], seen = new Set<number>();
  for (const value of checkPages) { const page = object(value), count = integer(page.total_count, 'check total'); total ??= count; metadata(total === count, 'check count changed; retry'); for (const raw of array(page.check_runs)) { const run = object(raw), id = integer(run.id, 'check ID', 1); metadata(!seen.has(id), 'duplicate check'); seen.add(id); metadata(text(run.head_sha, 'check head SHA') === sha, 'check commit'); runs.push(run); } }
  metadata(runs.length === total, 'truncated checks');
  const statusPages = array(await github.api(`repos/${github.config.repo}/commits/${sha}/status?per_page=100`, ['--paginate', '--slurp']), 'status pages');
  metadata(statusPages.length > 0, 'status pages');
  const statuses: JsonObject[] = []; total = undefined; const contexts = new Set<string>();
  for (const value of statusPages) {
    const page = object(value); metadata(text(page.sha, 'status SHA') === sha, 'status commit'); const count = integer(page.total_count, 'status count'); total ??= count; metadata(total === count, 'status count changed; retry');
    for (const raw of array(page.statuses)) { const status = object(raw), context = text(status.context, 'status context'); metadata(!contexts.has(context), 'duplicate status context'); contexts.add(context); statuses.push(status); }
  }
  metadata(statuses.length === total, 'truncated statuses');
  let pending = false, failed = false;
  for (const run of runs) {
    const status = oneOf(run.status, ['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'] as const, 'check status');
    if (status !== 'completed') pending = true;
    else { const conclusion = oneOf(run.conclusion, ['success', 'neutral', 'skipped', 'failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'] as const, 'check conclusion'); if (!['success', 'neutral', 'skipped'].includes(conclusion)) failed = true; }
  }
  for (const status of statuses) { const state = oneOf(status.state, ['error', 'failure', 'pending', 'success'] as const, 'status state'); if (state === 'pending') pending = true; else if (state !== 'success') failed = true; }
  return failed ? 'failed' : pending ? 'pending' : runs.length + statuses.length ? 'passed' : 'none';
}
export async function inspectPullRequest(github: GitHub, issue: number): Promise<PullRequestInfo | null> {
  const branch = branchName(github.config, issue), prs = await github.pullRequests(branch), pr = onlyOpen(prs, branch) ?? prs.at(-1);
  if (!pr) return null;
  const status = await pullRequestStatus(github, pr.number), head = object(status.head, 'PR head'), base = object(status.base, 'PR base');
  const sha = text(head.sha, 'head SHA'); metadata(/^[a-f0-9]{40,64}$/i.test(sha), 'head SHA');
  metadata(text(head.ref, 'head ref') === branch && text(object(head.repo).full_name).toLowerCase() === github.config.repo.toLowerCase(), 'canonical PR head');
  metadata(text(object(base.repo).full_name).toLowerCase() === github.config.repo.toLowerCase(), 'PR base repository');
  const raw = await readReviews(github, pr.number), conversation = await github.restPages(`repos/${github.config.repo}/issues/${pr.number}/comments?per_page=100`);
  // The configured queue owner is the approval authority; agent output cannot gain authority through a shared login.
  const trusted = (user: unknown): boolean => { if (user === null) return false; const u = object(user); return text(u.login).toLowerCase() === github.config.owner.toLowerCase() && u.type !== 'Bot'; };
  const feedback: Feedback[] = [];
  for (const comment of humanComments(conversation)) {
    const rawComment = conversation.find(c => c.id === comment.id)!; if (!trusted(rawComment.user) || !comment.body.trim()) continue;
    feedback.push({ id: `comment:${comment.id}:${comment.updated_at}`, author: comment.author!, body: comment.body, submittedAt: comment.updated_at });
  }
  for (const review of submittedReviews(raw.reviews, raw.comments)) {
    const rawReview = raw.reviews.find(r => r.id === review.id)!; if (!trusted(rawReview.user)) continue;
    const commitSha = text(rawReview.commit_id, 'review commit SHA');
    const bodies = [review.body, ...review.comments.map(c => c.body)].filter(body => body.trim() && !agentText(body));
    if (!bodies.length) continue;
    feedback.push({ id: `review:${review.id}`, author: review.author!, body: bodies.join('\n\n'), submittedAt: review.submitted_at, commitSha });
  }
  const ci = await checks(github, sha), latest = await pullRequestStatus(github, pr.number);
  metadata(text(object(latest.head).sha) === sha && latest.state === status.state && latest.draft === status.draft && latest.merged === status.merged, 'pull request changed during inspection; retry');
  return { number: pr.number, url: text(status.html_url), headSha: sha, head: branch, base: text(base.ref), draft: boolean(status.draft), state: status.merged ? 'MERGED' : status.state === 'closed' ? 'CLOSED' : 'OPEN', checks: ci, feedback: feedback.sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.id.localeCompare(b.id)) };
}
