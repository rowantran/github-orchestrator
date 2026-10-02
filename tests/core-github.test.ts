import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, paginate } from '../orchestrator/core/github.js';
import { Core } from '../orchestrator/core/index.js';
import { issueRef } from '../orchestrator/core/domain.js';
import { CommandError, type Command, type Runner } from '../orchestrator/core/process.js';
import type { Config } from '../orchestrator/core/types.js';
import { byAgent, ReviewCursor, submittedReviews } from '../orchestrator/core/reviews.js';

const config: Config = { repo: 'acme/repo', owner: 'alice', checkout: '/tmp', project_url: 'https://github.com/users/alice/projects/1', base_branch: 'main', vault: null, agents: {} };
const page = (nodes: unknown[], totalCount = nodes.length, hasNextPage = false, endCursor: string | null = null) => ({ totalCount, nodes, pageInfo: { hasNextPage, endCursor } });
const ref = (number: number) => ({ id: `I${number}`, number, url: `https://github.com/acme/repo/issues/${number}`, repository: { nameWithOwner: 'acme/repo' } });
const rawPr = (number: number, state = 'OPEN', draft = false, base = 'main') => ({ id: `PR${number}`, number: number + 100, url: `https://github.com/acme/repo/pull/${number + 100}`, repository: { nameWithOwner: config.repo }, headRepository: { nameWithOwner: config.repo }, state, merged: state === 'MERGED', isDraft: draft, baseRefName: base, headRefName: `alice/gh-${number}`, mergeCommit: state === 'MERGED' ? { oid: 'm'.repeat(40) } : null });
function rawIssue(number: number, options: { blockers?: number[]; state?: string; reason?: string; labels?: string[]; assigned?: string } = {}) {
  return { ...ref(number), title: `Task ${number}`, body: 'Task details', state: options.state ?? 'OPEN', stateReason: options.reason ?? null,
    issueDependenciesSummary: { totalBlockedBy: options.blockers?.length ?? 0 }, assignees: page([{ id: 'U1', login: options.assigned ?? 'alice' }]), projectItems: page([{ id: `PI${number}`, project: { id: 'P1' } }]), closedByPullRequestsReferences: page([]), labels: page((options.labels ?? []).map((name, i) => ({ id: `L${i}`, name }))) };
}
class FakeGitHub implements Runner {
  commands: Command[] = [];
  issues = new Map<number, ReturnType<typeof rawIssue>>([[1, rawIssue(1)], [2, rawIssue(2, { blockers: [1], labels: ['bug', 'gho:workstream:One/feature'] })], [3, rawIssue(3, { state: 'CLOSED', reason: 'COMPLETED', assigned: 'someone-else' })]]);
  prs = new Map<string, ReturnType<typeof rawPr>[]>([['alice/gh-1', [rawPr(1)]], ['alice/gh-3', [rawPr(3, 'MERGED')]]]);
  labels = ['bug', 'gho:workstream:One', 'gho:workstream:One/feature', 'gho:workstream:empty'];
  archived = true;
  intercept?: (args: readonly string[], query: string, variables: Record<string, string>) => unknown;
  async run(command: Command): Promise<string> {
    this.commands.push(command); const args = command.argv;
    if (args[0] === 'git') { if (args.includes('worktree')) return ''; if (args.includes('--quiet')) throw new CommandError('git', 1, ''); throw new Error(`Unexpected git ${args.join(' ')}`); }
    assert.equal(args[0], 'gh'); assert.equal(command.env?.GH_HOST, 'github.com');
    const variables: Record<string, string> = {}; for (let i = 0; i < args.length; i++) if (args[i] === '-f' || args[i] === '-F') { const value = args[i + 1]!, split = value.indexOf('='); variables[value.slice(0, split)] = value.slice(split + 1); }
    const query = variables.query ?? '', overridden = this.intercept?.(args, query, variables); if (overridden !== undefined) return typeof overridden === 'string' ? overridden : JSON.stringify(overridden);
    if (args[1] === 'project' && args[2] === 'view') return JSON.stringify({ id: 'P1', title: 'Project', url: config.project_url });
    if (args.includes('graphql')) {
      if (query.includes('archivedStates:')) return JSON.stringify({ data: { node: { __typename: 'ProjectV2', id: 'P1', items: page([...this.issues.keys()].map(n => ({ id: `PI${n}`, isArchived: n === 3 && this.archived, type: 'ISSUE', content: { __typename: 'Issue', ...ref(n) } }))) } } });
      if (query.includes('issue_')) { const repository: Record<string, unknown> = {}; for (const m of query.matchAll(/issue_(\d+):/g)) repository[`issue_${m[1]}`] = this.issues.get(Number(m[1])); return JSON.stringify({ data: { repository } }); }
      if (query.includes('pr_')) { const repository: Record<string, unknown> = {}; for (const m of query.matchAll(/pr_(\d+):/g)) repository[`pr_${m[1]}`] = page(this.prs.get(variables[`branch_${m[1]}`]!) ?? []); return JSON.stringify({ data: { repository } }); }
      if (query.includes('pullRequests(')) { let prs = this.prs.get(variables.branch!) ?? []; if (query.includes('states: [OPEN]')) prs = prs.filter(pr => pr.state === 'OPEN'); return JSON.stringify({ data: { repository: { pullRequests: page(prs) } } }); }
      return JSON.stringify({ data: { repository: { issue: this.issues.get(Number(variables.number)) } } });
    }
    const endpoint = args[4]!;
    if (endpoint.startsWith('repos/acme/repo/issues?')) return JSON.stringify([[...this.issues.values()].filter(i => i.state === 'OPEN').map(i => ({ number: i.number, html_url: i.url, state: i.state.toLowerCase(), assignees: i.assignees.nodes }))]);
    if (endpoint === 'repos/acme/repo/labels?per_page=100') return JSON.stringify([this.labels.map(name => ({ name }))]);
    if (endpoint.includes('/dependencies/blocked_by')) { const number = Number(endpoint.split('/')[4]); return JSON.stringify([number === 2 ? [{ number: 1, html_url: ref(1).url }] : []]); }
    throw new Error(`Unexpected gh command: ${args.join(' ')}`);
  }
}

test('strict pagination rejects truncation, changed counts, duplicate nodes and stuck cursors', async () => {
  await assert.rejects(paginate(async () => page([{ id: 'a' }], 2)), /truncated/);
  await assert.rejects(paginate(async () => page([{ id: 'a' }, { id: 'a' }])), /duplicate/);
  await assert.rejects(paginate(async () => page([], 2, true, 'next')), /did not advance/);
  let count = 0; await assert.rejects(paginate(async () => ++count === 1 ? page([{ id: 'a' }], 2, true, 'next') : page([{ id: 'b' }], 3)), /changed/);
  count = 0; assert.equal((await paginate(async () => ++count === 1 ? page([{ id: 'a' }], 2, true, 'next') : page([{ id: 'b' }], 2))).length, 2);
});
test('queue confirms live membership and assignment and derives stack by canonical head', async () => {
  const fake = new FakeGitHub(), entries = await new Core(config, fake).ready(true);
  assert.deepEqual(entries.map(e => e.state), ['ready_for_review', 'ready']); assert.deepEqual(entries[1]?.state === 'ready' && entries[1].stack_on, [1]);
  assert.ok(fake.commands.every(c => c.argv[0] === 'git' || c.env?.GH_HOST === 'github.com'));
});
test('snapshot directly enumerates archived Project members, preserves empty workstreams and merged stacked PRs', async () => {
  const fake = new FakeGitHub(), snapshot = await new Core(config, fake).snapshot();
  assert.deepEqual(snapshot.tasks.map(t => t.number), [1, 2, 3]); assert.equal(snapshot.tasks[2]?.state, 'done');
  assert.equal(snapshot.tasks[2]?.pull_requests[0]?.state, 'MERGED'); assert.deepEqual(snapshot.tasks[1]?.workstreams, ['One/feature']); assert.ok(snapshot.workstreams.includes('empty'));
  assert.ok(fake.commands.some(c => c.argv.some(a => a.includes('archivedStates: [ARCHIVED, NOT_ARCHIVED]'))));
  assert.ok(!fake.commands.some(c => c.argv.some(a => a.includes('/issues?') || a.includes('/pulls?'))));
  assert.ok(fake.commands.every(c => (c.timeoutMs ?? 60_000) <= 90_000));
});
test('Project hydration batches fifty identities and resumes overflowing label connections', async () => {
  const fake = new FakeGitHub(); fake.issues = new Map(Array.from({ length: 101 }, (_, i) => [i + 10, rawIssue(i + 10)])); fake.prs.clear();
  const first = Array.from({ length: 100 }, (_, i) => ({ id: `LABEL${i}`, name: `label-${i}` }));
  fake.issues.get(10)!.labels = page(first, 101, true, 'labels-next');
  fake.intercept = (_args, query, variables) => {
    if (variables.number === '10' && variables.cursor === 'labels-next' && query.includes('labels(')) return { data: { repository: { issue: { ...ref(10), labels: page([{ id: 'LABEL100', name: 'gho:workstream:last' }], 101) } } } };
    return undefined;
  };
  const snapshot = await new Core(config, fake).snapshot(); assert.equal(snapshot.tasks.length, 101); assert.deepEqual(snapshot.tasks[0]?.workstreams, ['last']);
  const batched = fake.commands.filter(c => c.argv.some(a => a.includes('issue_') && a.includes('issueDependenciesSummary'))); assert.equal(batched.length, 3);
  assert.ok(batched.every(c => [...(c.argv.find(a => a.startsWith('query=')) ?? '').matchAll(/issue_\d+:/g)].length <= 50));
});
test('GraphQL errors, wrong issue identity, and missing batched connections fail closed', async () => {
  const fake = new FakeGitHub(); fake.intercept = (_args, query) => query.includes('issue(number:') ? { errors: [{ message: 'Denied' }], data: { repository: null } } : undefined;
  await assert.rejects(new GitHub(config, fake).issue(issueRef(config.repo, 1)), /GraphQL error/);
  fake.intercept = (_args, query) => query.includes('issue(number:') ? { data: { repository: { issue: rawIssue(2) } } } : undefined;
  await assert.rejects(new GitHub(config, fake).issue(issueRef(config.repo, 1)), /issue identity/);
  fake.intercept = (_args, query) => query.includes('issue_') ? { data: { repository: Object.fromEntries([...fake.issues].map(([number, issue]) => [`issue_${number}`, { ...issue, assignees: undefined }])) } } : undefined;
  await assert.rejects(new Core(config, fake).snapshot(), /missing batched issue connections/);
});
test('an inaccessible Project, redacted item, missing alias, or partial dependency list fails closed', async () => {
  for (const mode of ['project', 'redacted', 'alias', 'dependencies']) {
    const fake = new FakeGitHub(); fake.intercept = (args, query) => {
      if (mode === 'project' && args[1] === 'project') return {};
      if (mode === 'redacted' && query.includes('archivedStates')) return { data: { node: { __typename: 'ProjectV2', id: 'P1', items: page([{ id: 'PI', type: 'REDACTED', isArchived: false, content: null }]) } } };
      if (mode === 'alias' && query.includes('issue_')) return { data: { repository: {} } };
      if (mode === 'dependencies' && args.some(a => a.includes('/2/dependencies/'))) return [[]];
      return undefined;
    };
    await assert.rejects(new Core(config, fake).snapshot(), /metadata/);
  }
});
test('fork branches are not task PRs and duplicate open PRs fail', async () => {
  const fake = new FakeGitHub(), fork = { ...rawPr(1), headRepository: { nameWithOwner: 'fork/repo' } }; fake.prs.set('alice/gh-1', [fork]);
  assert.equal(await new GitHub(config, fake).openPullRequest('alice/gh-1'), null);
  fake.prs.set('alice/gh-1', [rawPr(1), { ...rawPr(1), id: 'PR2', number: 201, url: 'https://github.com/acme/repo/pull/201' }]);
  await assert.rejects(new GitHub(config, fake).openPullRequest('alice/gh-1'), /More than one/);
});
test('workstream membership appends only, encodes slash labels, validates all repositories before writes', async () => {
  const fake = new FakeGitHub(), core = new Core(config, fake); let mutations = 0;
  fake.intercept = (args) => {
    if (args.includes('POST')) { mutations++; assert.ok(args.includes('labels[]=gho:workstream:One')); return [{ name: 'bug' }, { name: 'gho:workstream:One/feature' }, { name: 'gho:workstream:One' }]; }
    if (args.includes('DELETE')) { mutations++; assert.ok(args.some(a => a.endsWith('gho%3Aworkstream%3AOne%2Ffeature'))); return [{ name: 'bug' }]; }
    return undefined;
  };
  await core.addToWorkstream('One', [2, 2]); assert.equal(mutations, 1);
  await core.removeFromWorkstream('One/feature', [2]); assert.equal(mutations, 2);
  await assert.rejects(core.addToWorkstream('One', [1, 'https://github.com/other/repo/issues/2']), /cannot change/); assert.equal(mutations, 2);
});
test('workstream mutations report partial writes and never retry transport failures', async () => {
  const fake = new FakeGitHub(); let mutations = 0;
  fake.intercept = args => {
    if (!args.includes('POST')) return undefined;
    mutations++;
    if (mutations === 1) return [{ name: 'gho:workstream:One' }];
    throw new CommandError('gh', 1, 'HTTP 503');
  };
  await assert.rejects(new Core(config, fake).addToWorkstream('One', [1, 2, 3]), /Earlier successful issues: https:\/\/github.com\/acme\/repo\/issues\/1.*remaining issues were not attempted/); assert.equal(mutations, 2);
});
test('issue creation verifies setup and reports partial creation without retrying', async () => {
  const fake = new FakeGitHub(), core = new Core(config, fake); let creates = 0;
  fake.intercept = (args) => {
    if (args[1] === 'issue' && args[2] === 'create') { creates++; assert.ok(args.includes('--blocked-by')); assert.ok(args.includes('https://github.com/acme/repo/issues/1')); return 'https://github.com/acme/repo/issues/2\n'; }
    if (args[1] === 'project' && args[2] === 'item-add') return { id: 'PI2' };
    return undefined;
  };
  const issue = await core.createTask({ title: 'Task 2', body: 'body', blockedBy: [1] }); assert.equal(issue.reference.number, 2); assert.equal(creates, 1);
  fake.issues.get(2)!.projectItems = page([]);
  await assert.rejects(core.createTask({ title: 'Task 2', body: 'body', blockedBy: [1] }), /Created .* setup is incomplete.*Repair this issue/); assert.equal(creates, 2);
});
test('reviews keep human empty-body approvals but ignore agent bodies and agent-only replies', () => {
  const review = { id: 1, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/acme/repo/pull/1#review-1', body: '' };
  assert.equal(byAgent(review, []), false); assert.equal(byAgent({ ...review, body: ' [agent:] approved' }, []), true); assert.equal(byAgent(review, [{ body: '[agent:] reply' }]), true);
  assert.equal(submittedReviews([review], []).length, 1);
  const cursor = new ReviewCursor(); cursor.advance(review.submitted_at, 2); cursor.advance(review.submitted_at, 1); assert.equal(cursor.toString(), '2026-01-01T00:00:00Z,1,2'); assert.ok(new ReviewCursor(cursor.toString()).covers(review.submitted_at, 2)); assert.throws(() => new ReviewCursor('bad,1'));
});
test('PR inspection uses trusted human feedback, exact head SHA and combined CI status', async () => {
  const fake = new FakeGitHub(), sha = 'a'.repeat(40), status = { number: 101, html_url: 'https://github.com/acme/repo/pull/101', state: 'open', merged: false, draft: true, head: { sha, ref: 'alice/gh-1', repo: { full_name: config.repo } }, base: { ref: 'main', repo: { full_name: config.repo } } };
  const comment = (id: number, login: string, body: string) => ({ id, user: { login, type: 'User' }, body, html_url: `https://github.com/acme/repo/pull/101#issuecomment-${id}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  fake.intercept = (args) => {
    const endpoint = args[4];
    if (endpoint === 'repos/acme/repo/pulls/101') return status;
    if (endpoint?.includes('/pulls/101/reviews')) return [[]];
    if (endpoint?.includes('/pulls/101/comments')) return [[]];
    if (endpoint?.includes('/issues/101/comments')) return [[comment(1, 'alice', `/gho approve ${sha}`), comment(2, 'stranger', `/gho approve ${sha}`), comment(3, 'alice', '[agent:] /gho approve')]];
    if (endpoint?.includes('/check-runs?')) return [{ total_count: 1, check_runs: [{ id: 1, head_sha: sha, status: 'completed', conclusion: 'success' }] }];
    if (endpoint?.includes('/status?')) return [{ sha, total_count: 1, statuses: [{ context: 'build', state: 'pending' }] }];
    return undefined;
  };
  const core = new Core(config, fake), info = await core.inspectPullRequest(1); assert.equal(info?.headSha, sha); assert.equal(info?.checks, 'pending'); assert.equal(info?.feedback.length, 1); assert.equal(info?.feedback[0]?.body, `/gho approve ${sha}`);
  const normal = fake.intercept;
  fake.intercept = (args, query, variables) => args[4]?.includes('/check-runs?') ? [{ total_count: 1, check_runs: [{ id: 1, head_sha: sha, status: 'completed', conclusion: 'failure' }] }] : normal(args, query, variables);
  assert.equal((await core.inspectPullRequest(1))?.checks, 'failed');
  fake.intercept = (args, query, variables) => args[4]?.includes('/check-runs?') ? [{ total_count: 2, check_runs: [] }] : normal(args, query, variables);
  await assert.rejects(core.inspectPullRequest(1), /truncated checks/);
  let reads = 0;
  fake.intercept = (args, query, variables) => args[4] === 'repos/acme/repo/pulls/101' && ++reads === 2 ? { ...status, head: { ...status.head, sha: 'b'.repeat(40) } } : normal(args, query, variables);
  await assert.rejects(core.inspectPullRequest(1), /changed during inspection/);
});
test('publish and rework only change draft state, never merge', async () => {
  const fake = new FakeGitHub(); let draft = true;
  fake.intercept = args => {
    if (args[1] === 'pr') { assert.equal(args[2], 'ready'); draft = args.includes('--undo'); return ''; }
    if (args[4] === 'repos/acme/repo/pulls/101') return { number: 101, html_url: 'https://github.com/acme/repo/pull/101', state: 'open', merged: false, draft };
    return undefined;
  };
  const core = new Core(config, fake); await core.publishPullRequest(101); assert.equal(draft, false); await core.draftPullRequest(101); assert.equal(draft, true);
  assert.ok(fake.commands.every(c => !c.argv.includes('merge')));
});
