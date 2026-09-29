import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fingerprint, receipt, type CompletionRequest, type Link, type Receipt } from "../src/bridge";
import { COMPLETION_MAX_AGE_MS, processCompletion, type CompletionPort } from "../src/completion";

const link: Link = {
  id: "11111111-1111-4111-8111-111111111111", notePath: "Tasks/task.md",
  issueUrls: ["https://github.com/example/repo/issues/1"],
};
const request: CompletionRequest = {
  schemaVersion: 1, id: "22222222-2222-4222-8222-222222222222", linkId: link.id,
  issueUrls: link.issueUrls, issueFingerprint: fingerprint(link.issueUrls), requestedAt: new Date().toISOString(),
};

function harness() {
  const state = { stored: undefined as Receipt | undefined, calls: 0, status: "Not started", available: true,
    links: [link], writes: [] as Receipt[], notices: [] as string[] };
  const port: CompletionPort = {
    readReceipt: async () => state.stored,
    saveReceipt: async value => { state.stored = value; state.writes.push(value); },
    registry: async () => ({ schemaVersion: 1, links: state.links }),
    resolve: async value => ({ path: value.notePath, status: state.status }),
    apiAvailable: () => state.available,
    setDone: async () => {
      assert.equal(state.stored?.status, "processing", "durable claim must precede side effect");
      state.calls++; state.status = "Done";
    },
    notice: message => { state.notices.push(message); },
  };
  return { state, port };
}

test("local completion is claimed, accepted, never remotely confirmed, and deduplicated", async () => {
  const { state, port } = harness();
  await processCompletion(request, port);
  assert.equal(state.calls, 1);
  assert.equal(state.stored?.status, "local-accepted");
  assert.equal(state.stored?.notionConfirmed, false);
  await processCompletion(request, port);
  assert.equal(state.calls, 1);
  assert.equal(state.writes.length, 2);
});

test("unavailable TaskNotes emits terminal actionable receipt without YAML fallback", async () => {
  const { state, port } = harness();
  state.available = false;
  await processCompletion(request, port);
  assert.equal(state.stored?.status, "api-unavailable");
  assert.match(state.stored!.detail, /Enable\/update TaskNotes/);
  state.available = true;
  await processCompletion(request, port);
  assert.equal(state.calls, 0, "capability restoration must not automatically replay a terminal request");
});

test("changed association or issue set is rejected before any task API call", async () => {
  const { state, port } = harness();
  state.links = [{ ...link, issueUrls: ["https://github.com/example/repo/issues/2"] }];
  await processCompletion(request, port);
  assert.equal(state.stored?.status, "stale");
  assert.equal(state.calls, 0);
});

test("interrupted durable claims are not replayed after restart", async () => {
  const { state, port } = harness();
  state.stored = receipt(request, "processing", "claim");
  await processCompletion(request, port);
  assert.equal(state.stored.status, "interrupted");
  await processCompletion(request, port);
  assert.equal(state.calls, 0);
});

test("immediate rollback and later Notion rejection never trigger automatic retries", async () => {
  const immediate = harness();
  immediate.port.setDone = async () => { immediate.state.calls++; };
  await processCompletion(request, immediate.port);
  assert.equal(immediate.state.stored?.status, "rolled-back");
  await processCompletion(request, immediate.port);
  assert.equal(immediate.state.calls, 1);

  const later = harness();
  await processCompletion(request, later.port);
  later.state.status = "Not started";
  await processCompletion(request, later.port);
  assert.equal(later.state.stored?.status, "rolled-back");
  await processCompletion(request, later.port);
  assert.equal(later.state.calls, 1);
});

test("API exceptions produce terminal failures and already-done tasks do not repeat side effects", async () => {
  const failed = harness();
  failed.port.setDone = async () => { failed.state.calls++; throw new Error("unavailable"); };
  await processCompletion(request, failed.port);
  assert.equal(failed.state.stored?.status, "failed");
  await processCompletion(request, failed.port);
  assert.equal(failed.state.calls, 1);

  const done = harness();
  done.state.status = "Done";
  await processCompletion(request, done.port);
  assert.equal(done.state.stored?.status, "already-done");
  assert.equal(done.state.calls, 0);
  assert.equal(done.state.stored?.notionConfirmed, false);
});

test("requests older than 24 hours expire without touching TaskNotes", async () => {
  const { state, port } = harness();
  const expiredAt = Date.parse(request.requestedAt) + COMPLETION_MAX_AGE_MS + 1;
  await processCompletion(request, port, expiredAt);
  assert.equal(state.stored?.status, "stale");
  assert.match(state.stored!.detail, /older than 24 hours/);
  assert.equal(state.calls, 0);
  assert.equal(state.writes.length, 1);
  await processCompletion(request, port, expiredAt + 1);
  assert.equal(state.writes.length, 1, "expired receipts are terminal and not replayed");
});

test("exactly 24-hour-old requests remain valid", async () => {
  const { state, port } = harness();
  await processCompletion(request, port, Date.parse(request.requestedAt) + COMPLETION_MAX_AGE_MS);
  assert.equal(state.stored?.status, "local-accepted");
  assert.equal(state.calls, 1);
});

test("old accepted receipts remain accepted and never replay because of age", async () => {
  const { state, port } = harness();
  await processCompletion(request, port);
  await processCompletion(request, port, Date.parse(request.requestedAt) + 7 * COMPLETION_MAX_AGE_MS);
  assert.equal(state.stored?.status, "local-accepted");
  assert.equal(state.stored?.notionConfirmed, false);
  assert.equal(state.calls, 1);
  assert.equal(state.writes.length, 2);
});

test("invalid receipts block execution rather than permit duplicate effects", async () => {
  const { state, port } = harness();
  state.stored = { ...receipt(request, "local-accepted", "prior"), linkId: "different" };
  await assert.rejects(processCompletion(request, port), /mismatch/);
  assert.equal(state.calls, 0);
});
