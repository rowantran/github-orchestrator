import type { Config, Entry, Issue, IssueRef, LinkedPullRequest, PullRequest, WorkState } from './types.js';
import { branchName, completed, issueKey, issueUrl, linked } from './domain.js';
export interface Issues { issue(reference: IssueRef): Promise<Issue>; openPullRequest(branch: string): Promise<PullRequest | null> }
export interface Branches { worktrees(): Promise<Map<string, string>>; branchExists(branch: string): Promise<boolean> }
export async function surveyIssues(config: Config, source: Issues, workspace: Branches, issues: Issue[]): Promise<Entry[]> {
  const classifier = new Classifier(config, source, workspace, await workspace.worktrees());
  for (const issue of issues) classifier.issues.set(issueKey(issue.reference), issue);
  const entries: Entry[] = []; for (const issue of issues) entries.push(await classifier.entry(issue)); return entries;
}
class Classifier {
  readonly issues = new Map<string, Issue>();
  private states = new Map<string, WorkState>();
  private visiting = new Set<string>();
  private reviews = new Map<number, LinkedPullRequest | null>();
  private locals = new Map<string, { branch: string | null; worktree: string | null }>();
  constructor(private config: Config, private source: Issues, private workspace: Branches, private trees: Map<string, string>) {}
  private async issue(reference: IssueRef): Promise<Issue> { const key = issueKey(reference); let issue = this.issues.get(key); if (!issue) { issue = await this.source.issue(reference); this.issues.set(key, issue); } return issue; }
  private async local(reference: IssueRef): Promise<{ branch: string | null; worktree: string | null }> {
    if (reference.repo.toLowerCase() !== this.config.repo.toLowerCase()) return { branch: null, worktree: null };
    const branch = branchName(this.config, reference.number), cached = this.locals.get(branch); if (cached) return cached;
    const path = this.trees.get(branch), result = path ? { branch, worktree: path } : { branch: await this.workspace.branchExists(branch) ? branch : null, worktree: null }; this.locals.set(branch, result); return result;
  }
  private async review(number: number): Promise<LinkedPullRequest | null> {
    if (!this.reviews.has(number)) { const pr = await this.source.openPullRequest(branchName(this.config, number)); this.reviews.set(number, pr ? linked(pr) : null); } return this.reviews.get(number) ?? null;
  }
  private branchIssue(branch: string): number | null {
    const prefix = `${this.config.owner}/gh-`; if (!branch.startsWith(prefix)) return null;
    const tail = branch.slice(prefix.length), number = Number(tail); return /^[1-9][0-9]*$/.test(tail) && Number.isSafeInteger(number) && branchName(this.config, number) === branch ? number : null;
  }
  private async state(issue: Issue): Promise<WorkState> {
    const key = issueKey(issue.reference), cached = this.states.get(key); if (cached) return cached;
    if (this.visiting.has(key)) return { state: 'blocked' };
    this.visiting.add(key); try { const state = await this.compute(issue); this.states.set(key, state); return state; } finally { this.visiting.delete(key); }
  }
  private async compute(issue: Issue): Promise<WorkState> {
    if (issue.state === 'CLOSED') return completed(issue) ? { state: 'done' } : { state: 'closed', reason: issue.state_reason };
    if (issue.reference.repo.toLowerCase() === this.config.repo.toLowerCase()) {
      const pr = await this.review(issue.reference.number); if (pr) return pr.draft ? { state: 'in_progress' } : { state: 'ready_for_review', pull_request: pr };
    }
    if ((await this.local(issue.reference)).branch) return { state: 'in_progress' };
    const inReview = new Map<number, LinkedPullRequest>();
    for (const reference of issue.blockers) {
      const state = await this.state(await this.issue(reference)); if (state.state === 'done') continue;
      if (state.state === 'ready_for_review') inReview.set(reference.number, state.pull_request); else return { state: 'blocked' };
    }
    const stack = await this.stack(inReview); return stack ? { state: 'ready', stack_on: stack } : { state: 'blocked' };
  }
  private async stack(inReview: Map<number, LinkedPullRequest>): Promise<number[] | null> {
    if (!inReview.size) return [];
    for (const [tip, pr] of [...inReview].sort(([a], [b]) => a - b)) {
      const chain = [tip], seen = new Set([tip]); let base = pr.base;
      for (;;) { const number = this.branchIssue(base); if (!number || seen.has(number)) break; seen.add(number); const below = await this.review(number); if (!below) break; if (inReview.has(number)) chain.push(number); base = below.base; }
      if (chain.length === inReview.size) return chain.reverse();
    }
    return null;
  }
  async entry(issue: Issue): Promise<Entry> {
    const blockers = [];
    for (const reference of issue.blockers) { const blocker = await this.issue(reference); blockers.push({ number: reference.number, repo: reference.repo, url: issueUrl(reference), title: blocker.title, ...await this.state(blocker), ...await this.local(reference), pull_requests: blocker.pull_requests.map(linked) }); }
    const local = await this.local(issue.reference);
    return { number: issue.reference.number, title: issue.title, url: issueUrl(issue.reference), ...await this.state(issue), branch: local.branch ?? branchName(this.config, issue.reference.number), worktree: local.worktree, blockers, body: issue.body };
  }
}
