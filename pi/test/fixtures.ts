/** Purpose: offline fixtures for the launch contract. Audience: test maintainers. Injection: test data only; never a real agent run. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import type { WorkerContext } from "../context.ts";
import { loadResources, TOOL_NAMES, type WorkerResources } from "../resources.ts";
import { installWorker } from "../worker.ts";

export const assetRoot = new URL("../../agent-context/", import.meta.url);
export function readAsset(name: string): string { return readFileSync(new URL(name, assetRoot), "utf8"); }
export function promptBody(name: string): string {
  const source = readAsset(name);
  const header = source.match(/^<!--[^]*?-->\s*/);
  assert.ok(header, `${name} must have a leading purpose/audience/injection comment`);
  return source.slice(header[0].length);
}
export function render(name: string, values: Record<string, string>): string {
  return promptBody(name).replace(/\{\{([a-z_]+)\}\}/g, (_match, key: string) => {
    assert.ok(Object.hasOwn(values, key), `missing placeholder ${key}`);
    return values[key];
  });
}
export const bootstrap = "Read AGENTS.md in full before planning, editing, verifying, or handing off. Follow its repository-specific instructions and use the nearest project README for project-local commands and guidance.";
export function contextData(): WorkerContext {
  return {
    schema: 1,
    run_id: "run-unit-test-1",
    issue: { url: "https://github.com/example/repo/issues/42", title: "Test the worker", body: "Keep the literal {{branch}} token in fixture data.\nUse <tag> & Unicode λ." },
    base_commit: "a".repeat(40),
    branch: "gho/42",
    context_files: [{ path: "AGENTS.md", content: "Keep repository safety guidance.\nDo not read secrets." }],
    expected_bootstrap: bootstrap,
  };
}
export type BeforeHandler = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;
export function fixture(resources: WorkerResources = loadResources(), terminate: (code: number) => never = () => { throw new Error("unexpected termination"); }) {
  const cwd = mkdtempSync(join(tmpdir(), "gho-worker-test-"));
  const inputDir = join(cwd, ".gho", "input");
  mkdirSync(inputDir, { recursive: true });
  const path = join(inputDir, "context.json");
  const context = contextData();
  writeFileSync(path, JSON.stringify(context));
  const registered: ToolDefinition[] = [];
  let flag: unknown = path;
  let active: string[] = [...TOOL_NAMES];
  let before: BeforeHandler | undefined;
  let flagDescription: string | undefined;
  const api = {
    registerFlag(name: string, options: { description: string }) { assert.equal(name, "gho-context"); flagDescription = options.description; },
    registerTool(tool: ToolDefinition) { registered.push(tool); },
    on(name: string, handler: BeforeHandler) { assert.equal(name, "before_agent_start"); before = handler; return () => {}; },
    getFlag(name: string) { assert.equal(name, "gho-context"); return flag; },
    getActiveTools() { return active; },
    getAllTools() { return registered.map((tool) => ({ ...tool, sourceInfo: {} })) as unknown as ToolInfo[]; },
  };
  installWorker(api as unknown as ExtensionAPI, cwd, resources, terminate);
  assert.ok(before);
  const handler = before;
  const schema = JSON.parse(readAsset("result.schema.json"));
  delete schema._purpose;
  const system = render("worker-system.md", {
    context_files: context.context_files.map((file) => `### ${file.path}\n\n${file.content}`).join("\n\n"),
  });
  const task = render("worker-task.md", {
    run_id: context.run_id, issue_url: context.issue.url, issue_title: context.issue.title, issue_body: context.issue.body,
    base_commit: context.base_commit, branch: context.branch, result_schema: JSON.stringify(schema, null, 2),
  });
  const options = normalizeBuildSystemPromptOptions({
    cwd, customPrompt: system, appendSystemPrompt: `${bootstrap}\n\n${promptBody("worker-append.md")}`,
    selectedTools: active,
    toolSnippets: Object.fromEntries(registered.map((tool) => [tool.name, tool.promptSnippet!])),
    toolGuidelines: Object.fromEntries(registered.map((tool) => [tool.name, tool.promptGuidelines!])),
  });
  const event: BeforeAgentStartEvent = {
    type: "before_agent_start", prompt: task,
    get systemPrompt() { return buildSystemPrompt(options); },
    systemPromptOptions: options,
  };
  return {
    cwd, inputDir, path, context, registered, event, api, resources,
    flagDescription,
    setFlag(value: unknown) { flag = value; },
    setActive(value: string[]) { active = value; },
    run: () => handler(event, { cwd } as ExtensionContext),
    cleanup: () => {
      if (existsSync(inputDir)) chmodSync(inputDir, 0o700);
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
