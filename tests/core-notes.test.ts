import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Notes, notePath } from '../orchestrator/core/notes.js';
import { digest } from '../orchestrator/core/domain.js';

const url = (n: number) => `https://github.com/acme/repo/issues/${n}`;
async function vault(t: { after(fn: () => Promise<unknown>): void }): Promise<{ path: string; notes: Notes; note: string }> {
  const path = await mkdtemp(join(tmpdir(), 'gho-core-notes-')); t.after(() => rm(path, { recursive: true, force: true })); await mkdir(join(path, 'Tasks')); const note = 'Tasks/task.md'; await writeFile(join(path, note), '---\ntype: task\nstatus: open\n---\nBody must not change.\n'); return { path, notes: await Notes.open(path), note };
}
test('note links are canonical, stable, replace or union issues and never edit the note', async t => {
  const { path, notes, note } = await vault(t), before = await readFile(join(path, note), 'utf8');
  const first = await notes.link(note, [url(2), 'https://github.com/ACME/Repo/issues/1/', url(2)]); assert.deepEqual(first.issueUrls, [url(1), url(2)]);
  const second = await notes.link(note, [url(3)]); assert.equal(second.id, first.id); assert.deepEqual(second.issueUrls, [url(3)]);
  assert.deepEqual((await notes.add(note, [url(2)])).issueUrls, [url(2), url(3)]); assert.equal((await notes.links()).length, 1); assert.equal(await readFile(join(path, note), 'utf8'), before);
});
test('Notion identity survives rename but rejects identity replacement', async t => {
  const { path, notes, note } = await vault(t), id = 'a'.repeat(32); await writeFile(join(path, note), `---\ntype: task\nnotion_page_id: ${id}\n---\n`);
  const original = await notes.link(note, [url(1)]); await rename(join(path, note), join(path, 'Tasks/renamed.md'));
  const renamed = await notes.add('Tasks/renamed.md', [url(2)]); assert.equal(renamed.id, original.id); assert.equal(renamed.notionPageId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  await writeFile(join(path, 'Tasks/renamed.md'), '---\ntype: task\n---\n'); await assert.rejects(notes.link('Tasks/renamed.md', [url(1)]), /identity changed/);
});
test('frontmatter parser handles YAML safely and rejects ambiguous identities', async t => {
  const { path, notes, note } = await vault(t);
  for (const text of ['---\ntype: note\n---', '---\ntype: task\nnotion_managed: true\n---', '---\ntype: task\ntype: note\n---', '---\ntype: task\na: &value hello\nb: *value\n---', '---\ntype: !!str task\n---', '---\ntype: task\nnotion_page_id: 42\n---', '---\ntype: task\n' + 'x'.repeat(131_073)]) {
    await writeFile(join(path, note), text); await assert.rejects(notes.link(note, [url(1)]));
  }
  await writeFile(join(path, note), '\uFEFF---\ntype: "task" # comment\nitems: [one, two]\n---\n'); assert.ok(await notes.link(note, [url(1)]));
});
test('vault paths and bridge symlinks are refused before any write', async t => {
  const { path, notes, note } = await vault(t);
  for (const bad of ['../outside.md', '/absolute.md', '.hidden/task.md', 'Tasks\\note.md', 'C:/task.md', 'Tasks//note.md']) assert.throws(() => notePath(bad));
  const outside = await mkdtemp(join(tmpdir(), 'gho-core-notes-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(path, '.github-orchestrator')); await assert.rejects(notes.link(note, [url(1)]), /symlink/); assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(outside)), []);
});
test('completion requests use exact-set fingerprints and validate receipts and current associations', async t => {
  const { path, notes, note } = await vault(t), link = await notes.link(note, [url(1)]);
  assert.equal(await notes.completionState(link), null);
  const request = await notes.requestCompletion(link); assert.equal(request.issueFingerprint, digest([url(1)])); assert.equal((await notes.completionState(link))?.status, 'pending');
  await mkdir(join(path, '.github-orchestrator/receipts'));
  const receiptPath = join(path, '.github-orchestrator/receipts', `${request.id}.json`), receipt = { schemaVersion: 1, requestId: request.id, linkId: link.id, issueFingerprint: request.issueFingerprint, status: 'local-accepted' };
  await writeFile(receiptPath, JSON.stringify(receipt)); assert.equal((await notes.completionState(link))?.status, 'local-accepted');
  await writeFile(receiptPath, JSON.stringify({ ...receipt, issueFingerprint: 'wrong' })); await assert.rejects(notes.completionState(link), /receipt identity/);
  await notes.add(note, [url(2)]); await assert.rejects(notes.requestCompletion(link), /association changed/);
});
test('bridge fingerprints match the shared plugin protocol rather than another implementation helper', async t => {
  const { notes, note } = await vault(t);
  const urls = ['https://github.com/example/repo/issues/1', 'https://github.com/example/repo/issues/2'];
  const link = await notes.link(note, [urls[1]!, urls[0]!]);
  assert.equal((await notes.requestCompletion(link)).issueFingerprint, 'b31b2186802fd46f54480c60f1bac881ed06486050bb4336028576a246ae6da8');
});

test('concurrent bridge writers preserve separate links and union updates to one task', async t => {
  const { path, notes, note } = await vault(t), original = await readFile(join(path, note), 'utf8');
  const peers = await Promise.all(Array.from({ length: 6 }, () => Notes.open(path)));
  await Promise.all(peers.map(async (peer, i) => {
    const other = `Tasks/task-${i}.md`; await writeFile(join(path, other), original);
    await peer.link(other, [url(i + 1)]);
  }));
  assert.equal((await notes.links()).length, peers.length);
  await Promise.all(peers.map((peer, i) => peer.add(note, [url(i + 1)])));
  const links = await notes.links();
  assert.equal(links.length, peers.length + 1);
  assert.deepEqual(links.find(link => link.notePath === note)?.issueUrls, peers.map((_, i) => url(i + 1)));
  assert.equal(await readFile(join(path, note), 'utf8'), original);
});

test('completion uses the newest exact-set request and processed receipts do not expire', async t => {
  const { path, notes, note } = await vault(t), link = await notes.link(note, [url(1)]);
  const old = await notes.requestCompletion(link), requests = join(path, '.github-orchestrator/requests');
  await writeFile(join(requests, `${old.id}.json`), JSON.stringify({ ...old, requestedAt: '2020-01-01T00:00:00Z' }));
  const receipts = join(path, '.github-orchestrator/receipts'); await mkdir(receipts);
  const receipt = { schemaVersion: 1, requestId: old.id, linkId: link.id, issueFingerprint: old.issueFingerprint, status: 'local-accepted' };
  await writeFile(join(receipts, `${old.id}.json`), JSON.stringify(receipt));
  assert.equal((await notes.completionState(link))?.status, 'local-accepted');
  const latest = await notes.requestCompletion(link);
  assert.equal((await notes.completionState(link))?.requestId, latest.id);
  assert.equal((await notes.completionState(link))?.status, 'pending');
  const latestPath = join(receipts, `${latest.id}.json`);
  for (const status of ['processing', 'local-accepted', 'already-done', 'failed', 'api-unavailable', 'stale', 'rolled-back', 'interrupted']) {
    await writeFile(latestPath, JSON.stringify({ ...receipt, requestId: latest.id, status }));
    assert.equal((await notes.completionState(link))?.status, status);
  }
  await writeFile(latestPath, JSON.stringify({ ...receipt, requestId: latest.id, status: 'done' }));
  await assert.rejects(notes.completionState(link), /receipt identity or status/);
  await rm(latestPath); await symlink(join(receipts, `${old.id}.json`), latestPath);
  await assert.rejects(notes.completionState(link), /symlink/);
  const changed = await notes.add(note, [url(2)]);
  assert.equal(await notes.completionState(changed), null, 'an old issue set cannot complete a changed association');
});

test('stale requests can be retried and registry corruption cannot be replaced', async t => {
  const { path, notes, note } = await vault(t), link = await notes.link(note, [url(1)]), request = await notes.requestCompletion(link);
  await writeFile(join(path, '.github-orchestrator/requests', `${request.id}.json`), JSON.stringify({ ...request, requestedAt: '2020-01-01T00:00:00Z' })); assert.equal((await notes.completionState(link))?.status, 'stale');
  const registryPath = join(path, '.github-orchestrator/links.json'); await writeFile(registryPath, '{ broken'); await assert.rejects(notes.link(note, [url(2)]), /bridge JSON/); assert.equal(await readFile(registryPath, 'utf8'), '{ broken');
});
