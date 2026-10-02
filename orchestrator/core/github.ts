import type { Config, Issue, IssueRef, Project, PullRequest, StateReason } from './types.js';
import { array, boolean, ensure, integer, issueKey, issueUrl, metadata, nullableText, object, oneOf, parseIssue, text, uniqueLabels, validateRepo, workstreamLabel, workstreamNames, type JsonObject } from './domain.js';
import { type Runner, systemRunner } from './process.js';

const PR_FIELDS = 'id number url state merged isDraft baseRefName headRefName mergeCommit { oid } repository { nameWithOwner } headRepository { nameWithOwner }';
const ISSUE_FIELDS = 'title body state stateReason issueDependenciesSummary { totalBlockedBy }';
const PAGE = 'totalCount pageInfo { hasNextPage endCursor }';
const IDENTITY = 'id number url repository { nameWithOwner }';
const projectPath = (url: string) => {
  const match = /^https:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9-]+)\/projects\/([1-9][0-9]*)(?:\/views\/[1-9][0-9]*)?\/?(?:[?#].*)?$/.exec(url);
  ensure(match, 'Use a github.com user or organization Project URL.');
  return { kind: match[1]!, owner: match[2]!, number: match[3]! };
};
export async function paginate(fetch: (cursor?: string) => Promise<unknown>): Promise<JsonObject[]> {
  const result: JsonObject[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, expected: number | undefined;
  for (;;) {
    const page = object(await fetch(cursor), 'connection'), total = integer(page.totalCount, 'totalCount');
    expected ??= total; metadata(total === expected, 'connection changed during pagination; retry');
    const nodes = array(page.nodes, 'connection nodes'), info = object(page.pageInfo, 'pageInfo');
    for (const value of nodes) { const node = object(value, 'connection node'), id = text(node.id, 'node ID'); metadata(!ids.has(id), 'duplicate connection node'); ids.add(id); result.push(node); }
    metadata(result.length <= expected, 'connection count');
    const next = nullableText(info.endCursor, 'endCursor');
    if (!boolean(info.hasNextPage, 'hasNextPage')) { metadata(result.length === expected, 'truncated connection'); return result; }
    metadata(nodes.length > 0 && result.length < expected && next && !cursors.has(next), 'pagination did not advance');
    cursors.add(next); cursor = next;
  }
}
export function checkIssueIdentity(reference: IssueRef, value: unknown): JsonObject {
  const node = object(value, 'issue'); text(node.id, 'issue ID');
  const actual = parseIssue(text(node.url, 'issue URL'));
  metadata(issueKey(actual) === issueKey(reference) && integer(node.number, 'issue number', 1) === reference.number, 'issue identity');
  metadata(text(object(node.repository).nameWithOwner, 'issue repository').toLowerCase() === reference.repo.toLowerCase(), 'issue repository');
  return node;
}
export function parsePullRequest(value: unknown): PullRequest {
  const node = object(value, 'pull request'); text(node.id, 'PR ID');
  const number = integer(node.number, 'PR number', 1), url = text(node.url, 'PR URL'), repo = text(object(node.repository).nameWithOwner, 'PR repository'); validateRepo(repo);
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  metadata(match && match[1]!.toLowerCase() === repo.toLowerCase() && Number(match[2]) === number, 'pull request identity');
  const state = oneOf(node.state, ['OPEN', 'CLOSED', 'MERGED'] as const, 'PR state'), merged = boolean(node.merged, 'merged');
  metadata(merged === (state === 'MERGED'), 'pull request merged state');
  const merge_commit = node.mergeCommit === null ? null : text(object(node.mergeCommit, 'mergeCommit').oid, 'merge commit');
  metadata(!merged || merge_commit !== null, 'merged pull request commit');
  return { number, url, repo, state, draft: boolean(node.isDraft, 'isDraft'), base: text(node.baseRefName, 'baseRefName'), head: text(node.headRefName, 'headRefName'), merge_commit };
}
export class GitHub {
  private projectValue?: Project;
  constructor(readonly config: Config, readonly runner: Runner = systemRunner) { validateRepo(config.repo); metadata(/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(config.owner), 'owner login'); projectPath(config.project_url); }
  run(args: string[]): Promise<string> { return this.runner.run({ argv: ['gh', ...args], cwd: this.config.checkout, env: { GH_HOST: 'github.com' } }); }
  async json(args: string[]): Promise<unknown> { const result = await this.run(args); try { return JSON.parse(result); } catch { throw new Error('GitHub returned invalid JSON; no success assumed.'); } }
  api(endpoint: string, extra: string[] = []): Promise<unknown> { return this.json(['api', '--hostname', 'github.com', endpoint, ...extra]); }
  async graphql(query: string, variables: Record<string, string | number> = {}): Promise<JsonObject> {
    const args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    const response = object(await this.json(args), 'GraphQL response');
    if (response.errors != null && !(Array.isArray(response.errors) && response.errors.length === 0)) throw new Error(`GitHub GraphQL error: ${JSON.stringify(response.errors).slice(0, 2000)}`);
    return object(response.data, 'GraphQL data');
  }
  async restPages(endpoint: string): Promise<JsonObject[]> {
    const pages = array(await this.api(endpoint, ['--paginate', '--slurp']), 'REST pagination'); metadata(pages.length, 'REST pagination');
    return pages.flatMap(page => array(page, 'REST page').map(value => object(value, 'REST item')));
  }
  async resolveProject(url = this.config.project_url): Promise<Project> {
    const wanted = projectPath(url), node = object(await this.json(['project', 'view', wanted.number, '--owner', wanted.owner, '--format', 'json']), 'project');
    const project = { id: text(node.id, 'project ID'), url: text(node.url, 'project URL'), title: text(node.title, 'project title') }, actual = projectPath(project.url);
    metadata(wanted.kind === actual.kind && wanted.owner.toLowerCase() === actual.owner.toLowerCase() && wanted.number === actual.number, 'project URL'); return project;
  }
  async project(): Promise<Project> { return this.projectValue ??= await this.resolveProject(); }
  async issueData(reference: IssueRef, fields: string, cursor?: string): Promise<JsonObject> {
    const [owner, name] = reference.repo.split('/');
    const query = `query($owner: String!, $name: String!, $number: Int!${fields.includes('$cursor') ? ', $cursor: String' : ''}) { repository(owner: $owner, name: $name) { issue(number: $number) { ${IDENTITY} ${fields} } } }`;
    const data = await this.graphql(query, { owner: owner!, name: name!, number: reference.number, ...(cursor ? { cursor } : {}) });
    return checkIssueIdentity(reference, object(data.repository, 'repository').issue);
  }
  async issueBatch(references: IssueRef[], fields: string): Promise<JsonObject[]> {
    metadata(references.length <= 50 && new Set(references.map(issueKey)).size === references.length, 'issue batch');
    for (const ref of references) metadata(ref.repo.toLowerCase() === this.config.repo.toLowerCase(), 'issue batch repository');
    const [owner, name] = this.config.repo.split('/');
    const selections = references.map(ref => `issue_${ref.number}: issue(number: ${ref.number}) { ${IDENTITY} ${fields} }`).join(' ');
    const data = await this.graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selections} } }`, { owner: owner!, name: name! });
    const repository = object(data.repository, 'repository'); return references.map(ref => checkIssueIdentity(ref, repository[`issue_${ref.number}`]));
  }
  async issueConnection(reference: IssueRef, field: string, selection: string, extra = '', initial?: unknown): Promise<JsonObject[]> {
    let first = initial;
    return paginate(async cursor => {
      if (first !== undefined) { const page = first; first = undefined; return page; }
      const data = await this.issueData(reference, `${field}(first: 100, after: $cursor${extra}) { ${PAGE} nodes { ${selection} } }`, cursor); return data[field];
    });
  }
  async issue(reference: IssueRef, projectIds?: string[], initial?: JsonObject): Promise<Issue> {
    const data = initial ?? await this.issueData(reference, ISSUE_FIELDS);
    if (initial) metadata(initial.assignees !== undefined && initial.closedByPullRequestsReferences !== undefined, 'missing batched issue connections');
    const title = text(data.title, 'issue title'), body = text(data.body, 'issue body', true), state = oneOf(data.state, ['OPEN', 'CLOSED'] as const, 'issue state');
    const state_reason: StateReason | null = data.stateReason === null ? null : oneOf(data.stateReason, ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'] as const, 'stateReason');
    metadata(state !== 'CLOSED' || state_reason !== null, 'closed issue stateReason');
    const expectedBlockers = integer(object(data.issueDependenciesSummary).totalBlockedBy, 'totalBlockedBy');
    const assignees = (await this.issueConnection(reference, 'assignees', 'id login', '', initial?.assignees)).map(a => text(a.login, 'assignee login'));
    if (!projectIds) {
      const project = await this.project();
      projectIds = (await this.issueConnection(reference, 'projectItems', 'id project { id }', ', includeArchived: true')).map(item => text(object(item.project).id, 'project ID'));
      metadata(projectIds.filter(id => id === project.id).length <= 1, 'duplicate project membership');
    }
    const pull_requests = (await this.issueConnection(reference, 'closedByPullRequestsReferences', PR_FIELDS, ', includeClosedPrs: true', initial?.closedByPullRequestsReferences)).map(parsePullRequest);
    const blockers = (await this.restPages(`repos/${reference.repo}/issues/${reference.number}/dependencies/blocked_by?per_page=100`)).map(node => {
      metadata(!('pull_request' in node), 'expected issue, not PR'); const ref = parseIssue(text(node.html_url, 'blocker URL')); metadata(ref.number === integer(node.number, 'blocker number', 1), 'blocker identity'); return ref;
    });
    metadata(blockers.length === expectedBlockers && new Set(blockers.map(issueKey)).size === blockers.length, 'incomplete or inaccessible blocking dependencies');
    return { reference, title, body, state, state_reason, assignees, project_ids: projectIds, blockers, pull_requests };
  }
  async queue(): Promise<Issue[]> {
    const project = await this.project(), seen = new Set<string>(), result: Issue[] = [];
    for (const node of await this.restPages(`repos/${this.config.repo}/issues?state=open&assignee=${this.config.owner}&per_page=100`)) {
      if ('pull_request' in node) continue;
      const ref = parseIssue(text(node.html_url, 'queue URL')); metadata(ref.number === integer(node.number, 'queue number', 1), 'queue issue identity');
      if (ref.repo !== this.config.repo.toLowerCase()) continue;
      metadata(!seen.has(issueKey(ref)), 'duplicate issue in paginated queue'); seen.add(issueKey(ref));
      const state = oneOf(text(node.state).toUpperCase(), ['OPEN', 'CLOSED'] as const, 'queue issue state');
      const assigned = array(node.assignees).map(a => text(object(a).login)).some(a => a.toLowerCase() === this.config.owner.toLowerCase());
      if (state !== 'OPEN' || !assigned) continue;
      const issue = await this.issue(ref);
      if (issue.state === 'OPEN' && issue.project_ids.includes(project.id) && issue.assignees.some(a => a.toLowerCase() === this.config.owner.toLowerCase())) result.push(issue);
    }
    return result.sort((a, b) => a.reference.number - b.reference.number);
  }
  async projectIssues(): Promise<Issue[]> {
    const project = await this.project();
    const query = `query($project: ID!, $cursor: String) { node(id: $project) { __typename ... on ProjectV2 { id items(first: 100, after: $cursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) { ${PAGE} nodes { id isArchived type content { __typename ... on Issue { ${IDENTITY} } } } } } } }`;
    const candidates = await paginate(async cursor => {
      const data = await this.graphql(query, { project: project.id, ...(cursor ? { cursor } : {}) }), node = object(data.node, 'project node');
      metadata(node.__typename === 'ProjectV2' && node.id === project.id, 'project identity'); return node.items;
    });
    const members: { reference: IssueRef; id: string }[] = [], seen = new Set<string>(), ids = new Set<string>();
    for (const candidate of candidates) {
      boolean(candidate.isArchived, 'isArchived');
      const kind = oneOf(candidate.type, ['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE'] as const, 'redacted or unknown project item type');
      const content = object(candidate.content, 'project item content'), expected = { ISSUE: 'Issue', PULL_REQUEST: 'PullRequest', DRAFT_ISSUE: 'DraftIssue' }[kind];
      metadata(content.__typename === expected, 'project item content type'); if (kind !== 'ISSUE') continue;
      const reference = parseIssue(text(content.url)); checkIssueIdentity(reference, content); const id = text(content.id);
      metadata(!seen.has(issueKey(reference)) && !ids.has(id), 'duplicate project issue'); seen.add(issueKey(reference)); ids.add(id);
      if (reference.repo === this.config.repo.toLowerCase()) members.push({ reference, id });
    }
    const fields = `${ISSUE_FIELDS} assignees(first: 100) { ${PAGE} nodes { id login } } closedByPullRequestsReferences(first: 100, includeClosedPrs: true) { ${PAGE} nodes { ${PR_FIELDS} } }`;
    const result: Issue[] = [];
    for (let i = 0; i < members.length; i += 50) {
      const chunk = members.slice(i, i + 50), nodes = await this.issueBatch(chunk.map(m => m.reference), fields);
      for (let j = 0; j < chunk.length; j++) { const member = chunk[j]!, node = nodes[j]!; metadata(node.id === member.id, 'project issue identity changed'); result.push(await this.issue(member.reference, [project.id], node)); }
    }
    return result.sort((a, b) => a.reference.number - b.reference.number);
  }
  async issueLabels(reference: IssueRef, initial?: unknown): Promise<string[]> { return uniqueLabels((await this.issueConnection(reference, 'labels', 'id name', '', initial)).map(l => text(l.name, 'label name'))); }
  async issueLabelsBatch(references: IssueRef[]): Promise<string[][]> {
    const result: string[][] = [];
    for (let i = 0; i < references.length; i += 50) { const chunk = references.slice(i, i + 50), nodes = await this.issueBatch(chunk, `labels(first: 100) { ${PAGE} nodes { id name } }`); for (let j = 0; j < chunk.length; j++) { metadata(nodes[j]!.labels !== undefined, 'labels'); result.push(await this.issueLabels(chunk[j]!, nodes[j]!.labels)); } }
    return result;
  }
  async pullRequests(branch: string, openOnly = false, initial?: unknown): Promise<PullRequest[]> {
    const [owner, name] = this.config.repo.split('/'); let first = initial;
    const query = `query($owner: String!, $name: String!, $branch: String!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, states: [${openOnly ? 'OPEN' : 'OPEN, CLOSED, MERGED'}], first: 100, after: $cursor) { ${PAGE} nodes { ${PR_FIELDS} } } } }`;
    const nodes = await paginate(async cursor => { if (first !== undefined) { const page = first; first = undefined; return page; } const data = await this.graphql(query, { owner: owner!, name: name!, branch, ...(cursor ? { cursor } : {}) }); return object(data.repository, 'repository').pullRequests; });
    const result: PullRequest[] = [];
    for (const node of nodes) {
      const headRepo = node.headRepository === null ? null : text(object(node.headRepository, 'headRepository').nameWithOwner).toLowerCase(), pr = parsePullRequest(node);
      metadata(pr.head === branch && (!openOnly || pr.state === 'OPEN') && pr.repo.toLowerCase() === this.config.repo.toLowerCase(), 'pull request branch/repository');
      if (headRepo === this.config.repo.toLowerCase()) result.push(pr);
    }
    return result.sort((a, b) => a.number - b.number);
  }
  async pullRequestsBatch(branches: string[]): Promise<PullRequest[][]> {
    const result: PullRequest[][] = [], [owner, name] = this.config.repo.split('/');
    for (let i = 0; i < branches.length; i += 50) {
      const chunk = branches.slice(i, i + 50), variables: Record<string, string> = { owner: owner!, name: name! };
      const declarations = chunk.map((branch, j) => { variables[`branch_${j}`] = branch; return `, $branch_${j}: String!`; }).join('');
      const selections = chunk.map((_, j) => `pr_${j}: pullRequests(headRefName: $branch_${j}, states: [OPEN, CLOSED, MERGED], first: 100) { ${PAGE} nodes { ${PR_FIELDS} } }`).join(' ');
      const data = await this.graphql(`query($owner: String!, $name: String!${declarations}) { repository(owner: $owner, name: $name) { ${selections} } }`, variables), repo = object(data.repository, 'repository');
      for (let j = 0; j < chunk.length; j++) { metadata(repo[`pr_${j}`] !== undefined, 'pull request connection'); result.push(await this.pullRequests(chunk[j]!, false, repo[`pr_${j}`])); }
    }
    return result;
  }
  async openPullRequest(branch: string): Promise<PullRequest | null> { return onlyOpen(await this.pullRequests(branch, true), branch); }
  async workstreams(): Promise<string[]> { return workstreamNames(uniqueLabels((await this.restPages(`repos/${this.config.repo}/labels?per_page=100`)).map(l => text(l.name, 'label name')))); }
  async createWorkstream(name: string): Promise<void> {
    const label = workstreamLabel(name), exists = async () => (await this.workstreams()).some(n => n.toLowerCase() === name.toLowerCase()); if (await exists()) return;
    try { const created = object(await this.api(`repos/${this.config.repo}/labels`, ['--method', 'POST', '-f', `name=${label}`, '-f', 'color=5319e7'])); metadata(text(created.name).toLowerCase() === label.toLowerCase(), 'created label name'); }
    catch (error) { if (String(error).includes('HTTP 422') && await exists()) return; throw new Error(`Could not verify workstream creation: ${String(error)}. Check repository labels before retrying.`); }
  }
  async changeWorkstream(name: string, references: IssueRef[], add: boolean): Promise<void> {
    const label = workstreamLabel(name); for (const ref of references) ensure(ref.repo.toLowerCase() === this.config.repo.toLowerCase(), `Workstream ${name} belongs to ${this.config.repo}; cannot change ${issueUrl(ref)}.`);
    ensure((await this.workstreams()).some(n => n.toLowerCase() === name.toLowerCase()), `Unknown workstream ${name}. Create it first.`);
    const completed: string[] = [], seen = new Set<string>();
    for (const reference of references) {
      if (seen.has(issueKey(reference))) continue; seen.add(issueKey(reference));
      try {
        const has = (labels: string[]) => labels.some(l => l.toLowerCase() === label.toLowerCase());
        if (has(await this.issueLabels(reference)) !== add) {
          const endpoint = `repos/${this.config.repo}/issues/${reference.number}/labels`;
          const response = add ? await this.api(endpoint, ['--method', 'POST', '-f', `labels[]=${label}`]) : await this.api(`${endpoint}/${encodeURIComponent(label)}`, ['--method', 'DELETE']);
          const labels = uniqueLabels(array(response).map(v => text(object(v).name))); metadata(has(labels) === add, 'workstream membership after update');
        }
      } catch (error) { throw new Error(`Could not ${add ? 'add to' : 'remove from'} workstream ${name} for ${issueUrl(reference)}: ${String(error)}. Earlier successful issues: ${completed.join(', ') || 'none'}. Failing issue may have changed; remaining issues were not attempted. Check membership before retrying.`); }
      completed.push(issueUrl(reference));
    }
  }
  async deleteWorkstream(name: string): Promise<void> { const label = workstreamLabel(name); await this.run(['api', '--hostname', 'github.com', `repos/${this.config.repo}/labels/${encodeURIComponent(label)}`, '--method', 'DELETE']); }
  async createIssue(title: string, body: string, blockers: IssueRef[]): Promise<Issue> {
    const project = await this.project(), path = projectPath(project.url), unique = [...new Map(blockers.map(b => [issueKey(b), b])).values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
    const args = ['issue', 'create', '--repo', `github.com/${this.config.repo}`, '--title', title, '--body', body, '--assignee', this.config.owner]; for (const blocker of unique) args.push('--blocked-by', issueUrl(blocker));
    let url: string;
    try { url = (await this.run(args)).trim(); } catch (error) { throw new Error(`${String(error)}\ngh may have created an issue titled ${JSON.stringify(title)} before failing. Search ${this.config.repo} before retrying; do not create it twice.`); }
    try {
      const reference = parseIssue(url); metadata(reference.repo === this.config.repo.toLowerCase(), 'created issue repository');
      text(object(await this.json(['project', 'item-add', path.number, '--owner', path.owner, '--url', issueUrl(reference), '--format', 'json'])).id, 'created project item ID');
      const issue = await this.issue(reference); metadata(issue.project_ids.includes(project.id), 'created issue Project membership');
      metadata(issue.assignees.some(a => a.toLowerCase() === this.config.owner.toLowerCase()), 'created issue assignee');
      metadata(unique.every(b => issue.blockers.some(ref => issueKey(ref) === issueKey(b))), 'created issue dependencies'); return issue;
    } catch (error) { throw new Error(`Created ${url}, but setup is incomplete: ${String(error)}. Repair this issue; do not recreate it.`); }
  }
}
export function onlyOpen(prs: PullRequest[], branch: string): PullRequest | null { const open = prs.filter(pr => pr.state === 'OPEN'); ensure(open.length <= 1, `More than one open pull request from ${branch}. Close the extras.`); return open[0] ?? null; }
