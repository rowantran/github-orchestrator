import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE, END, START, completionRequest, fingerprint, matchingLink, notePath, notionId,
  receipt, registry, renamedRegistry, renderLinks, type CompletionRequest, type Link,
} from "../src/bridge";
import { Store } from "../src/store";

const link: Link = {
  id: "11111111-1111-4111-8111-111111111111", notePath: "Tasks/task.md",
  issueUrls: ["https://github.com/example/repo/issues/1", "https://github.com/example/repo/issues/2"],
};
const request: CompletionRequest = {
  schemaVersion: 1, id: "22222222-2222-4222-8222-222222222222", linkId: link.id,
  issueUrls: link.issueUrls, issueFingerprint: fingerprint(link.issueUrls), requestedAt: "2026-01-01T00:00:00.000Z",
};
const managed = "---\ntype: task\nstatus: Not started\n---\n\n<!-- notion-task-sync:managed-start -->\n# Title\n<!-- notion-task-sync:managed-end -->\n\n## Local notes\n\nPrivate text  \n- [ ] Leave me\n";

test("request fingerprint agrees with Python canonical JSON and binds exact issue set", () => {
  assert.equal(fingerprint(link.issueUrls), createHash("sha256").update('["https://github.com/example/repo/issues/1","https://github.com/example/repo/issues/2"]').digest("hex"));
  assert.deepEqual(completionRequest(request), request);
  assert.equal(matchingLink(request, { schemaVersion: 1, links: [link] }), link);
  assert.equal(matchingLink(request, { schemaVersion: 1, links: [{ ...link, issueUrls: [link.issueUrls[0]] }] }), undefined);
  assert.throws(() => completionRequest({ ...request, issueFingerprint: "bad" }));
  assert.throws(() => completionRequest({ ...request, requestedAt: "bad" }));
  assert.throws(() => completionRequest({ ...request, issueUrls: [] }));
});

test("all receipts explicitly decline to confirm Notion", () => {
  for (const status of ["processing", "local-accepted", "already-done", "api-unavailable", "stale", "failed", "rolled-back", "interrupted"] as const) {
    const result = receipt(request, status, "detail", link.notePath);
    assert.equal(result.notionConfirmed, false);
    assert.equal(result.issueFingerprint, request.issueFingerprint);
    assert.equal(result.requestId, request.id);
    assert.equal(result.status, status);
  }
});

test("link insertion stays inside Local notes and preserves all existing bytes", () => {
  const tail = "\n## Another section\nDo not move or rewrite this.\n";
  const result = renderLinks(managed + tail, link, true);
  assert.ok(result.startsWith(managed));
  assert.ok(result.endsWith(tail.trimStart()));
  assert.ok(result.indexOf(START) > result.indexOf("## Local notes"));
  assert.ok(result.indexOf(END) < result.indexOf("## Another section"));
  assert.equal(renderLinks(result, link, true), result);
  const replacement = renderLinks(result, { ...link, issueUrls: [link.issueUrls[1]] }, true);
  const oldStart = result.indexOf(START), oldEnd = result.indexOf(END) + END.length;
  const newEnd = replacement.indexOf(END) + END.length;
  assert.equal(replacement.slice(0, oldStart), result.slice(0, oldStart));
  assert.equal(replacement.slice(newEnd), result.slice(oldEnd));
});

test("preserves CRLF, trailing spaces, YAML quotes and checklist state", () => {
  const input = managed.replaceAll("\n", "\r\n");
  const result = renderLinks(input, link, true);
  assert.ok(result.startsWith(input));
  assert.equal(result.replaceAll("\r\n", "").includes("\n"), false);
  assert.equal(renderLinks(result, link, true), result);
});

test("native task block can append without a Local notes section", () => {
  const input = "---\ntype: task\nstatus: 'Not started'\n---\n# Task\n- [ ] Keep";
  const result = renderLinks(input, link, false);
  assert.ok(result.startsWith(input));
  assert.ok(result.includes(START));
  assert.equal(result.includes("## Local notes"), false);
});

test("managed missing Local notes can be repaired only after managed-end", () => {
  const input = managed.slice(0, managed.indexOf("## Local notes"));
  assert.ok(renderLinks(input, link, true).includes("## Local notes\n\n" + START));
  assert.throws(() => renderLinks("---\ntype: task\n---\n", link, true), /managed-end/);
});

test("unsafe or ambiguous managed link markers are not rewritten", () => {
  assert.throws(() => renderLinks(managed + START, link, true), /markers/);
  const outside = `${START}\n${END}\n${managed}`;
  assert.throws(() => renderLinks(outside, link, true), /inside Local notes/);
  assert.throws(() => renderLinks(managed + `${START}\n${END}\n${START}\n${END}`, link, true), /markers/);
  assert.throws(() => renderLinks(managed + "## Local notes\n", link, true), /Multiple/);
  assert.throws(() => renderLinks(managed + "```\n", link, true), /Unterminated/);
});

test("headings and markers in fenced examples are not treated as structure", () => {
  const example = managed + `\n\`\`\`markdown\n${START}\n${END}\n## Local notes\n\`\`\`\n`;
  const result = renderLinks(example, link, true);
  assert.ok(result.startsWith(example));
});

test("file and folder renames preserve native stable IDs and issue sets", () => {
  const data = { schemaVersion: 1 as const, links: [link] };
  const single = renamedRegistry(data, "Tasks/task.md", "Tasks/renamed.md");
  assert.equal(single.links[0].notePath, "Tasks/renamed.md");
  assert.equal(single.links[0].id, link.id);
  assert.deepEqual(single.links[0].issueUrls, link.issueUrls);
  assert.equal(link.notePath, "Tasks/task.md", "input is not mutated");
  assert.equal(renamedRegistry(data, "Tasks", "Archive/Tasks").links[0].notePath, "Archive/Tasks/task.md");
  assert.equal(renamedRegistry(data, "Task", "Other").links[0].notePath, link.notePath);
  assert.throws(() => renamedRegistry(data, "Tasks", "../outside"));
  const other = { ...link, id: "33333333-3333-4333-8333-333333333333", notePath: "Tasks/existing.md" };
  assert.throws(() => renamedRegistry({ schemaVersion: 1, links: [link, other] }, "Tasks/task.md", other.notePath), /Duplicate/);
});

test("a Local notes heading inside Notion's managed region is not edited", () => {
  const input = managed.replace("# Title", "## Local notes").replace("\n## Local notes\n\nPrivate", "\nPrivate");
  assert.throws(() => renderLinks(input, link, true), /follow the Notion managed-end/);
});

test("registry refuses unsafe paths, duplicates and noncanonical URL sets", () => {
  for (const path of ["../escape.md", "/absolute.md", "Tasks/../escape.md", "Tasks\\escape.md", ".obsidian/task.md", "Tasks/.task.md"]) {
    assert.throws(() => notePath(path));
  }
  assert.equal(notePath("Tasks/normal task.md"), "Tasks/normal task.md");
  assert.throws(() => registry({ schemaVersion: 1, links: [link, link] }));
  assert.throws(() => registry({ schemaVersion: 1, links: [{ ...link, issueUrls: [] }] }));
  assert.throws(() => registry({ schemaVersion: 1, links: [{ ...link, issueUrls: [...link.issueUrls].reverse() }] }));
  assert.throws(() => registry({ schemaVersion: 1, links: [{ ...link, issueUrls: ["https://github.com/../repo/issues/1"] }] }));
  assert.equal(notionId("138CEA4547B442848362F67377F236FA"), "138cea45-47b4-4284-8362-f67377f236fa");
});

test("shared store locks serialize updates and atomic writes remain valid JSON", async () => {
  const vault = await mkdtemp(join(tmpdir(), "gho-store-"));
  try {
    const store = new Store(vault);
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.withLock(async () => {
      const data = await store.registry();
      data.links.push({ ...link, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, notePath: `Tasks/${index}.md` });
      await store.write(`${BRIDGE}/links.json`, data);
    })));
    assert.equal((await store.registry()).links.length, 10);
    assert.equal(JSON.parse(await readFile(join(vault, BRIDGE, "links.json"), "utf8")).links.length, 10);
  } finally { await rm(vault, { recursive: true, force: true }); }
});

test("store rejects note, bridge and request-directory symlinks", async () => {
  const vault = await mkdtemp(join(tmpdir(), "gho-vault-"));
  const outside = await mkdtemp(join(tmpdir(), "gho-outside-"));
  try {
    const store = new Store(vault);
    await symlink(outside, join(vault, BRIDGE));
    await assert.rejects(store.registry(), /symlink/);
    await rm(join(vault, BRIDGE));
    await mkdir(join(vault, BRIDGE));
    await symlink(outside, join(vault, BRIDGE, "requests"));
    await assert.rejects(store.requestIds(), /symlink/);
    await symlink(outside, join(vault, "Tasks"));
    await writeFile(join(outside, "task.md"), "---\ntype: task\n---\n");
    await assert.rejects(store.safe("Tasks/task.md"), /symlink/);
  } finally { await rm(vault, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
