import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../orchestrator/core/github.js';
import { checkReviews, ReviewCursor, submittedReviews } from '../orchestrator/core/reviews.js';
import type { Config } from '../orchestrator/core/types.js';
import type { JsonObject } from '../orchestrator/core/domain.js';
import type { Command, Runner } from '../orchestrator/core/process.js';

const config: Config = { repo: 'acme/repo', owner: 'alice', checkout: '/tmp', project_url: 'https://github.com/users/alice/projects/1', base_branch: 'main', vault: null, agents: {} };
const at = '2026-01-01T00:00:05Z';
const review = (id: number, body: string | null = '', state = 'COMMENTED', submitted_at: string | null = at): JsonObject => ({ id, body, state, submitted_at, user: { login: 'alice' }, html_url: `https://github.com/acme/repo/pull/5#review-${id}` });
const comment = (id: number, reviewId: number, body: string): JsonObject => ({ id, pull_request_review_id: reviewId, body, path: 'file.ts', line: 7, original_line: 3, html_url: `https://github.com/acme/repo/pull/5#comment-${id}` });
class ReviewSource implements Runner {
  commands: Command[] = [];
  reviews: JsonObject[][] = [[]];
  comments: JsonObject[][] = [[]];
  status: JsonObject = { number: 5, html_url: 'https://github.com/acme/repo/pull/5', state: 'open', merged: false, draft: true };
  github = new GitHub(config, this);
  async run(command: Command): Promise<string> {
    this.commands.push(command);
    assert.equal(command.env?.GH_HOST, 'github.com');
    const endpoint = command.argv[4];
    if (endpoint === 'repos/acme/repo/pulls/5') return JSON.stringify(this.status);
    assert.deepEqual(command.argv.slice(-2), ['--paginate', '--slurp']);
    if (endpoint === 'repos/acme/repo/pulls/5/reviews?per_page=100') return JSON.stringify(this.reviews);
    if (endpoint === 'repos/acme/repo/pulls/5/comments?per_page=100') return JSON.stringify(this.comments);
    throw new Error(`Unexpected command: ${command.argv.join(' ')}`);
  }
  get commentReads(): number { return this.commands.filter(c => c.argv[4]?.includes('/comments?')).length; }
}

test('review polling waits for submission and consumes agent reviews in the cursor', async () => {
  const source = new ReviewSource();
  source.reviews = [[review(1, '', 'PENDING', null)]];
  assert.equal((await checkReviews(source.github, 5)).result, 'waiting');
  assert.equal(source.commentReads, 0, 'pending review comments are not fetched');

  source.reviews[0]!.push(review(2));
  source.comments = [[comment(20, 2, '[agent:] Fixed.')]];
  const agent = await checkReviews(source.github, 5);
  assert.equal(agent.result, 'waiting');
  assert.equal(agent.cursor, `${at},2`);
  assert.equal((await checkReviews(source.github, 5, agent.cursor)).result, 'waiting');
  assert.equal(source.commentReads, 1, 'already consumed reviews need no comment fetch');

  source.reviews = [[review(3, 'A few things.')], [review(2), review(4, 'withdrawn', 'DISMISSED')]];
  source.comments.push([comment(30, 3, 'Rename this.'), { ...comment(31, 3, 'And this.'), line: null, in_reply_to_id: 20 }]);
  const human = await checkReviews(source.github, 5, agent.cursor);
  assert.equal(human.result, 'reviews');
  assert.deepEqual(human.reviews.map(r => r.id), [3]);
  assert.equal(human.cursor, `${at},2,3`);
  assert.deepEqual(human.pull_request, { number: 5, url: 'https://github.com/acme/repo/pull/5', draft: true });
  assert.equal(human.reviews[0]?.comments.length, 2);
  assert.deepEqual(human.reviews[0]?.comments[1], { id: 31, url: 'https://github.com/acme/repo/pull/5#comment-31', path: 'file.ts', line: 3, outdated: true, in_reply_to: 20, body: 'And this.' });
  const reads = source.commentReads;
  assert.equal((await checkReviews(source.github, 5, human.cursor)).result, 'waiting');
  assert.equal(source.commentReads, reads);
});

test('review batches preserve empty approvals, deleted authors, mixed comments and stable ordering', () => {
  const reviews = [review(9, 'later', 'CHANGES_REQUESTED', '2026-01-01T00:00:06Z'), { ...review(4, null, 'APPROVED'), user: null }, review(3), review(2, ' \n[agent:] summary'), review(1, '', 'PENDING', null)];
  const comments = [comment(30, 3, '[agent:] reply'), comment(31, 3, 'Human reply'), comment(20, 2, 'does not override agent summary'), comment(10, 1, 'not yet submitted')];
  const result = submittedReviews(reviews, comments);
  assert.deepEqual(result.map(r => r.id), [3, 4, 9]);
  assert.deepEqual(result[0]?.comments.map(c => c.body), ['[agent:] reply', 'Human reply']);
  assert.equal(result[1]?.author, null);
  assert.equal(result[1]?.body, '');
  assert.deepEqual(result[1]?.comments, []);
  assert.throws(() => submittedReviews([review(1), review(1)], []), /duplicate review/);
  for (const invalid of ['invalid', '2026-02-30T00:00:00Z']) assert.throws(() => submittedReviews([review(1, '', 'COMMENTED', invalid)], []), /timestamp/);
});

test('review cursors cover older submissions but retain unseen IDs at the same instant', () => {
  const cursor = new ReviewCursor('2026-01-01T01:00:05+01:00,4,3,4');
  assert.equal(cursor.toString(), `${at},3,4`);
  assert.equal(cursor.covers('2026-01-01T00:00:04Z', 99), true);
  assert.equal(cursor.covers(at, 3), true);
  assert.equal(cursor.covers(at, 5), false);
  assert.equal(cursor.covers('2026-01-01T00:00:06Z', 3), false);
  cursor.advance('2026-01-01T00:00:04Z', 99);
  assert.equal(cursor.toString(), `${at},3,4`);
  cursor.advance('2026-01-01T00:00:06Z', 5);
  assert.equal(cursor.toString(), '2026-01-01T00:00:06Z,5');
  assert.equal(new ReviewCursor('2024-02-29T00:00:05.123Z,1').toString(), '2024-02-29T00:00:05.123Z,1');
  for (const invalid of ['', at, `${at},`, `${at},0`, `${at},x`, `${at},9007199254740992`, '2026-02-29T00:00:05Z,1', '2026-01-01T24:00:00Z,1']) assert.throws(() => new ReviewCursor(invalid), /Invalid review cursor/);
});

test('merged and closed PRs end review polling without reading reviews', async () => {
  for (const merged of [false, true]) {
    const source = new ReviewSource(); source.status = { ...source.status, state: 'closed', merged };
    const result = await checkReviews(source.github, 5, `${at},3`);
    assert.equal(result.result, merged ? 'merged' : 'closed');
    assert.deepEqual(result.reviews, []);
    assert.equal(result.cursor, `${at},3`);
    assert.equal(source.commands.length, 1);
  }
  for (const changed of [{ number: 6 }, { html_url: 'https://github.com/other/repo/pull/5' }, { merged: true }]) {
    const source = new ReviewSource(); Object.assign(source.status, changed);
    await assert.rejects(checkReviews(source.github, 5), /metadata/);
    assert.equal(source.commands.length, 1);
  }
});
