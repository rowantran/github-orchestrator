/** Purpose: verify worker registration, execution, and pre-request auditing offline. Audience: maintainers. Injection: none. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveContext, parseContext, readContext, writeEffectiveContext } from "../context.ts";
import { loadResources, TOOL_NAMES } from "../resources.ts";
import { bootstrap, contextData, fixture } from "./fixtures.ts";

function auditInput(f: ReturnType<typeof fixture>) {
  return { path: f.path, context: f.context, cwd: f.cwd, toolCwd: f.cwd, event: f.event,
    activeTools: f.api.getActiveTools(), allTools: f.api.getAllTools(), resources: f.resources };
}

test("all seven registered tools use owned metadata and schemas, not factory descriptions", (t) => {
  const resources = loadResources();
  resources.tools.read.description = "Owned replacement description";
  resources.tools.read.parameters.properties.path = { type: "string", description: "Owned path description" };
  const f = fixture(resources); t.after(f.cleanup);
  assert.deepEqual(f.registered.map((tool) => tool.name), TOOL_NAMES);
  assert.equal(f.flagDescription, resources.strings.flags.context);
  for (const tool of f.registered) {
    const { execute, ...metadata } = tool;
    assert.equal(typeof execute, "function");
    assert.deepEqual(metadata, resources.tools[tool.name as (typeof TOOL_NAMES)[number]]);
    assert.ok(!JSON.stringify(metadata).includes("_purpose"));
  }
});

test("read, write, edit, bash, and ls execute upstream behavior relative to worker cwd", async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = f.registered.find((entry) => entry.name === name)!;
    const ctx = {
      cwd: f.cwd,
      sessionManager: { getSessionId: () => "offline-tool-test", getSessionFile: () => undefined },
    } as unknown as ExtensionContext;
    return tool.execute(`test-${name}`, args, undefined, undefined, ctx);
  };
  await run("write", { path: "sample.txt", content: "old line\n" });
  await run("edit", { path: "sample.txt", edits: [{ oldText: "old", newText: "new" }] });
  const read = await run("read", { path: "sample.txt" });
  assert.ok(JSON.stringify(read.content).includes("new line"));
  assert.equal(readFileSync(join(f.cwd, "sample.txt"), "utf8"), "new line\n");
  const bash = await run("bash", { command: "printf worker-cwd-ok; test -f sample.txt", timeout: 5 });
  assert.ok(JSON.stringify(bash.content).includes("worker-cwd-ok"));
  const ls = await run("ls", {});
  assert.ok(JSON.stringify(ls.content).includes("sample.txt"));
});

test("before_agent_start records the full effective prompt and selected schemas without model calls or prompt mutations", (t) => {
  const f = fixture(); t.after(f.cleanup);
  const original = f.event.systemPrompt;
  const optionsBefore = structuredClone(f.event.systemPromptOptions);
  // Parent snapshots stay read-only; the audit must be written outside .gho/input.
  chmodSync(f.inputDir, 0o500);
  t.after(() => { if (existsSync(f.inputDir)) chmodSync(f.inputDir, 0o700); });
  assert.equal(f.run(), undefined);
  assert.equal(f.event.systemPrompt, original);
  assert.deepEqual(f.event.systemPromptOptions, optionsBefore);
  const output = join(f.cwd, ".gho", "effective-context.json");
  const snapshot = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.run_id, f.context.run_id);
  assert.equal(snapshot.system_prompt, original);
  assert.equal(snapshot.task_prompt, f.event.prompt);
  assert.equal(snapshot.expected_bootstrap, bootstrap);
  assert.deepEqual(snapshot.context_files, f.context.context_files);
  assert.equal(snapshot.context_path, f.path);
  assert.deepEqual(snapshot.checks, { bootstrap_present: true, explicit_context_present: true, discovered_context_files: 0, discovered_skills: 0 });
  assert.deepEqual(snapshot.tools, TOOL_NAMES.map((name) => {
    const { label: _label, ...metadata } = f.resources.tools[name];
    return metadata;
  }));
  assert.ok(snapshot.assumptions.some((value: string) => value.includes("not a filesystem sandbox")));
  assert.match(snapshot._purpose, /not a cryptographic attestation/);
  assert.ok(snapshot.system_prompt.includes(bootstrap));
  assert.ok(snapshot.system_prompt.includes(f.context.context_files[0].content));
  assert.ok(!snapshot.system_prompt.includes("<!-- Purpose:"));
  assert.ok(snapshot.task_prompt.includes("literal {{branch}}"), "issue tokens must not be recursively expanded");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.inputDir, "effective-context.json")), false);
  assert.deepEqual(readdirSync(join(f.cwd, ".gho")).sort(), ["effective-context.json", "input"]);
  chmodSync(f.inputDir, 0o700);
});

test("audit fails on missing bootstrap, missing explicit guidance, ambient resources, or tool drift", (t) => {
  const scenarios: Array<[string, (f: ReturnType<typeof fixture>) => void, string]> = [
    ["bootstrap", (f) => { f.event.systemPromptOptions.appendSystemPrompt = ""; }, "missing_bootstrap"],
    ["guidance", (f) => { f.event.systemPromptOptions.customPrompt = "Worker only"; }, "missing_context_file"],
    ["ambient context", (f) => { f.event.systemPromptOptions.contextFiles.push({ path: "/home/AGENTS.md", content: "Ambient" }); }, "ambient_context"],
    ["ambient skill", (f) => { f.event.systemPromptOptions.skills.push({} as never); }, "ambient_context"],
    ["bootstrap in wrong section", (f) => { f.event.systemPromptOptions.customPrompt += bootstrap; f.event.systemPromptOptions.appendSystemPrompt = ""; }, "missing_bootstrap"],
    ["forced prompt", (f) => { f.event.systemPromptOptions.forceSystemPrompt = f.event.systemPrompt; }, "ambient_context"],
    ["default prompt", (f) => { f.event.systemPromptOptions.customPrompt = undefined; }, "ambient_context"],
    ["extra sections", (f) => { f.event.systemPromptOptions.sections.unreviewed = "Ambient"; }, "ambient_context"],
    ["active tools", (f) => { f.setActive(["read"]); }, "unexpected_tools"],
    ["selected tools", (f) => { f.event.systemPromptOptions.selectedTools.push("network_tool"); }, "unexpected_tools"],
    ["description", (f) => { f.registered[0].description = "Unreviewed"; }, "unexpected_tools"],
    ["schema", (f) => { f.registered[0].parameters = {} as never; }, "unexpected_tools"],
    ["guidelines", (f) => { f.registered[0].promptGuidelines = ["Unreviewed"]; }, "unexpected_tools"],
    ["snippet", (f) => { f.event.systemPromptOptions.toolSnippets.read = "Unreviewed"; }, "unexpected_tools"],
  ];
  for (const [name, mutate, error] of scenarios) {
    const f = fixture(); t.after(f.cleanup);
    mutate(f);
    assert.throws(() => effectiveContext(auditInput(f)), { message: f.resources.strings.errors[error] }, name);
    assert.equal(existsSync(join(f.cwd, ".gho", "effective-context.json")), false);
  }
});

test("invalid manifests and paths fail; symlink inputs cannot redirect the audit", (t) => {
  const f = fixture(); t.after(f.cleanup);
  const strings = f.resources.strings;
  for (const value of [null, {}, { ...contextData(), schema: 2 }, { ...contextData(), expected_bootstrap: "" },
    { ...contextData(), issue: { title: "missing URL" } }, { ...contextData(), context_files: [{ path: "AGENTS.md" }] },
    { ...contextData(), context_files: [contextData().context_files[0], contextData().context_files[0]] }]) {
    assert.throws(() => parseContext(value, strings), { message: strings.errors.invalid_context });
  }
  for (const path of [undefined, ".gho/input/context.json", join(f.cwd, ".gho", "context.json"), join(f.cwd, "other.json")]) {
    assert.throws(() => readContext(path, f.cwd, strings), { message: strings.errors.invalid_context_path });
  }
  const target = join(f.inputDir, "original.json");
  renameSync(f.path, target); symlinkSync(target, f.path);
  assert.throws(() => readContext(f.path, f.cwd, strings), { message: strings.errors.invalid_context_path });
  unlinkSync(f.path); renameSync(target, f.path);
  writeFileSync(f.path, "invalid JSON");
  assert.throws(() => readContext(f.path, f.cwd, strings), { message: strings.errors.context_io });
});

test("audit output failure is reported rather than ignored", (t) => {
  const f = fixture(); t.after(f.cleanup);
  const snapshot = effectiveContext(auditInput(f));
  const missingPath = join(f.cwd, "missing", "input", "context.json");
  assert.throws(() => writeEffectiveContext(missingPath, snapshot, f.resources.strings), { message: f.resources.strings.errors.context_io });
});

test("a failed lifecycle audit exits nonzero instead of relying on Pi's swallowed handler errors", (t) => {
  const f = fixture(); t.after(f.cleanup);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { installWorker } from ${JSON.stringify(new URL("../worker.ts", import.meta.url).href)};
    let handler;
    const pi = { registerFlag() {}, registerTool() {}, on(_, fn) { handler = fn; }, getFlag() { return undefined; } };
    installWorker(pi, ${JSON.stringify(f.cwd)});
    handler({}, { cwd: ${JSON.stringify(f.cwd)} });
    process.stdout.write("UNSAFE_CONTINUATION");
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr.trim(), f.resources.strings.errors.invalid_context_path);
});
