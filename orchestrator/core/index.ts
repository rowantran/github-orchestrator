import { dirname } from 'node:path';
import type { PullRequestInfo, TaskInfo } from '../types.js';
import type { Config, CreateTaskOptions, Created, DoctorResult, Entry, Issue, Snapshot } from './types.js';
import { branchName, completed, ensure, issueRef, issueUrl, linked, parseIssue, workstreamLabel, workstreamNames } from './domain.js';
import { GitHub, onlyOpen } from './github.js';
import { Notes, type CompletionRequest, type CompletionState, type Link } from './notes.js';
import { DeadlineRunner, type Runner, systemRunner } from './process.js';
import { checkReviews, inspectPullRequest, pullRequestStatus } from './reviews.js';
import { surveyIssues, type Issues } from './work.js';
import { resourcePath, Workspace } from './workspace.js';

export * from './types.js';
export { loadConfig, initConfig, locate, configDirectory, githubRemoteRepo } from './config.js';
export * from './process.js';
export * from './domain.js';
export { GitHub, paginate } from './github.js';
export { Workspace, renderBrief } from './workspace.js';
export { surveyIssues, type Issues, type Branches } from './work.js';
export { Notes, notePath, type Link, type CompletionRequest, type CompletionState, type CompletionStatus } from './notes.js';
export { ReviewCursor, submittedReviews, byAgent, checkReviews } from './reviews.js';

export class Core {
  readonly github: GitHub;
  readonly workspace: Workspace;
  constructor(readonly config: Config, readonly runner: Runner = systemRunner) { this.github = new GitHub(config, runner); this.workspace = new Workspace(config, runner); }
  async ready(all = false): Promise<Entry[]> {
    const github = new GitHub(this.config, this.runner), entries = await surveyIssues(this.config, github, this.workspace, await github.queue()); return entries.filter(entry => all || entry.state === 'ready');
  }
  async snapshot(): Promise<Snapshot> {
    const runner = new DeadlineRunner(this.runner, 90_000), github = new GitHub(this.config, runner), workspace = new Workspace(this.config, runner);
    const workstreams = await github.workstreams(), issues = await github.projectIssues(), references = issues.map(i => i.reference);
    const memberships = (await github.issueLabelsBatch(references)).map(workstreamNames), branches = references.map(r => branchName(this.config, r.number));
    const batches = await github.pullRequestsBatch(branches), cache = new Map(branches.map((b, i) => [b, batches[i]!]));
    const pullRequests = async (branch: string) => { if (!cache.has(branch)) cache.set(branch, await github.pullRequests(branch)); return cache.get(branch)!; };
    const linkIssue = async (issue: Issue): Promise<Issue> => {
      if (issue.reference.repo.toLowerCase() === this.config.repo.toLowerCase()) for (const pr of await pullRequests(branchName(this.config, issue.reference.number))) if (!issue.pull_requests.some(existing => existing.url.toLowerCase() === pr.url.toLowerCase())) issue.pull_requests.push(pr);
      issue.pull_requests.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number); return issue;
    };
    const source: Issues = { issue: async reference => linkIssue(await github.issue(reference)), openPullRequest: async branch => onlyOpen(await pullRequests(branch), branch) };
    for (const issue of issues) await linkIssue(issue);
    const entries = await surveyIssues(this.config, source, workspace, issues);
    return { repo: this.config.repo, project_url: this.config.project_url, workstreams, tasks: entries.map((entry, i) => ({ ...entry, workstreams: memberships[i]!, pull_requests: issues[i]!.pull_requests.map(linked) })) };
  }
  async createWorktree(number: number, base?: string): Promise<Created> {
    const reference = issueRef(this.config.repo, number), github = new GitHub(this.config, this.runner), issue = await github.issue(reference);
    if (base === undefined) {
      const entry = (await surveyIssues(this.config, github, this.workspace, [issue]))[0]!;
      ensure(entry.state === 'ready', `Issue #${number} is ${entry.state}${entry.worktree ? ` in ${entry.worktree}` : ''}. Use --base to start it anyway.`);
      const top = entry.stack_on.at(-1); if (top !== undefined) base = await this.workspace.fetch(branchName(this.config, top));
    }
    const created = await this.workspace.create(number, base); await this.workspace.writeBrief(created, issue.title); return created;
  }
  async recoverWorktree(number: number): Promise<Created | null> {
    const issue = await new GitHub(this.config, this.runner).issue(issueRef(this.config.repo, number));
    return this.workspace.recover(number, issue.title);
  }
  async createTask(options: CreateTaskOptions): Promise<Issue> {
    ensure(typeof options.title === 'string' && options.title.trim().length > 0, 'Task title must not be blank.'); ensure(typeof options.body === 'string' && options.body.trim().length > 0, 'Task body must not be blank.');
    const github = new GitHub(this.config, this.runner), blockers = (options.blockedBy ?? []).map(value => parseIssue(value, this.config.repo)), workstreams = [...new Set(options.workstreams ?? [])];
    for (const name of workstreams) workstreamLabel(name);
    if (workstreams.length) { const known = await github.workstreams(); for (const name of workstreams) ensure(known.some(n => n.toLowerCase() === name.toLowerCase()), `Unknown workstream ${name}. Create it first.`); }
    const notes = options.note ? await this.notes() : null; if (notes) { await notes.taskIdentity(options.note!); await notes.links(); }
    const issue = await github.createIssue(options.title, options.body, blockers);
    try { for (const name of workstreams) await github.changeWorkstream(name, [issue.reference], true); if (notes) await notes.add(options.note!, [issueUrl(issue.reference)]); }
    catch (error) { throw new Error(`Created ${issueUrl(issue.reference)}, but setup is incomplete: ${String(error)}. Repair this issue; do not recreate it.`); }
    return issue;
  }
  listWorkstreams(): Promise<string[]> { return this.github.workstreams(); }
  createWorkstream(name: string): Promise<void> { return this.github.createWorkstream(name); }
  addToWorkstream(name: string, issues: (string | number)[]): Promise<void> { return this.github.changeWorkstream(name, issues.map(value => parseIssue(value, this.config.repo)), true); }
  removeFromWorkstream(name: string, issues: (string | number)[]): Promise<void> { return this.github.changeWorkstream(name, issues.map(value => parseIssue(value, this.config.repo)), false); }
  deleteWorkstream(name: string): Promise<void> { return this.github.deleteWorkstream(name); }
  async inspectTask(number: number): Promise<TaskInfo> {
    const issue = await new GitHub(this.config, this.runner).issue(issueRef(this.config.repo, number)); return { number, title: issue.title, body: issue.body, state: issue.state, completed: completed(issue) };
  }
  inspectPullRequest(issue: number): Promise<PullRequestInfo | null> { return inspectPullRequest(new GitHub(this.config, this.runner), issue); }
  private async changeDraft(number: number, draft: boolean): Promise<void> {
    issueRef(this.config.repo, number); const github = new GitHub(this.config, this.runner), before = await pullRequestStatus(github, number);
    ensure(before.state === 'open' && before.merged === false, 'Only an open, unmerged pull request can change draft state.'); if (before.draft === draft) return;
    await github.run(['pr', 'ready', String(number), '--repo', `github.com/${this.config.repo}`, ...(draft ? ['--undo'] : [])]);
    const after = await pullRequestStatus(github, number); ensure(after.state === 'open' && after.draft === draft && after.merged === false, 'Pull request draft state could not be verified; inspect it before retrying.');
  }
  publishPullRequest(number: number): Promise<void> { return this.changeDraft(number, false); }
  draftPullRequest(number: number): Promise<void> { return this.changeDraft(number, true); }
  checkReviews(number: number, since?: string): ReturnType<typeof checkReviews> { return checkReviews(new GitHub(this.config, this.runner), number, since); }
  async doctor(): Promise<DoctorResult> {
    const checks: string[] = [], warnings: string[] = [];
    for (const executable of ['git', 'gh', 'wt']) { await this.runner.run({ argv: [executable, '--version'], cwd: this.config.checkout }); checks.push(`${executable} available`); }
    await this.workspace.verifyCheckout(); checks.push(`checkout matches ${this.config.repo}`);
    const github = new GitHub(this.config, this.runner), project = await github.project(), queue = await github.queue(); checks.push(`GitHub Project access: ${queue.length} open issues assigned to ${this.config.owner}`);
    for (const role of ['planner', 'implementer', 'reviewer'] as const) if (!this.config.agents[`${role}_model`]) warnings.push(`${role} model not set; Pi default will be used.`);
    return { ok: true, project, checks, warnings };
  }
  private notes(): Promise<Notes> { ensure(this.config.vault, 'Set [obsidian].vault in your config first.'); return Notes.open(this.config.vault); }
  async notesLink(note: string, issues: (string | number)[]): Promise<Link> {
    const refs = issues.map(value => parseIssue(value, this.config.repo)); for (const reference of refs) await this.github.issue(reference);
    return (await this.notes()).link(note, refs.map(issueUrl));
  }
  async notesList(): Promise<Link[]> { return (await this.notes()).links(); }
  async notesComplete(retry = false): Promise<Array<{ link: Link; state?: CompletionState; waiting?: string[]; request?: CompletionRequest }>> {
    const notes = await this.notes(), github = new GitHub(this.config, this.runner), result: Array<{ link: Link; state?: CompletionState; waiting?: string[]; request?: CompletionRequest }> = [];
    for (const link of await notes.links()) {
      const state = await notes.completionState(link);
      if (state && (['pending', 'processing', 'local-accepted', 'already-done'].includes(state.status) || !retry)) { result.push({ link, state }); continue; }
      const waiting: string[] = []; for (const url of link.issueUrls) if (!completed(await github.issue(parseIssue(url)))) waiting.push(url);
      result.push(waiting.length ? { link, waiting } : { link, request: await notes.requestCompletion(link) });
    }
    return result;
  }
  async notesInstall(yes = false, pluginDirectory?: string): Promise<string> { return (await this.notes()).install(pluginDirectory ?? dirname(await resourcePath('obsidian-plugin/manifest.json')), yes); }
}
