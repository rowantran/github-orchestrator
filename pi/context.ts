/** Purpose: verify and record the pre-request context. Audience: maintainers and offline tests. Injection: none; never rewrite prompts. */
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BeforeAgentStartEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { TOOL_NAMES, type WorkerResources, type WorkerStrings } from "./resources.ts";

export interface WorkerContext {
  schema: 1;
  run_id: string;
  issue: { url: string; title: string; body: string };
  base_commit: string;
  branch: string;
  context_files: Array<{ path: string; content: string }>;
  expected_bootstrap: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function parseContext(value: unknown, strings: WorkerStrings): WorkerContext {
  if (!record(value) || value.schema !== 1 || !nonempty(value.run_id) ||
      !record(value.issue) || !nonempty(value.issue.url) || !nonempty(value.issue.title) || typeof value.issue.body !== "string" ||
      !nonempty(value.base_commit) || !nonempty(value.branch) || !nonempty(value.expected_bootstrap) ||
      !Array.isArray(value.context_files) || value.context_files.some((file: unknown) =>
        !record(file) || !nonempty(file.path) || typeof file.content !== "string") ||
      new Set(value.context_files.map((file: { path: string }) => file.path)).size !== value.context_files.length) {
    throw new Error(strings.errors.invalid_context);
  }
  return value as unknown as WorkerContext;
}

export function readContext(flag: unknown, cwd: string, strings: WorkerStrings): { path: string; context: WorkerContext } {
  if (typeof flag !== "string" || !isAbsolute(flag) || resolve(flag) !== join(resolve(cwd), ".gho", "input", "context.json")) {
    throw new Error(strings.errors.invalid_context_path);
  }
  const path = resolve(flag);
  let raw: unknown;
  try {
    if (lstatSync(dirname(dirname(path))).isSymbolicLink() || lstatSync(dirname(path)).isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
      throw new Error(strings.errors.invalid_context_path);
    }
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === strings.errors.invalid_context_path) throw error;
    throw new Error(strings.errors.context_io);
  }
  return { path, context: parseContext(raw, strings) };
}

export interface AuditInput {
  path: string;
  context: WorkerContext;
  cwd: string;
  toolCwd: string;
  event: BeforeAgentStartEvent;
  activeTools: string[];
  allTools: ToolInfo[];
  resources: WorkerResources;
}

export function effectiveContext(input: AuditInput) {
  const { context, event, resources, activeTools } = input;
  const { strings } = resources;
  if (realpathSync(input.cwd) !== realpathSync(input.toolCwd)) throw new Error(strings.errors.invalid_worktree);
  const options = event.systemPromptOptions;
  if (options.contextFiles.length || options.skills.length || options.forceSystemPrompt !== undefined ||
      !options.customPrompt?.trim() || Object.keys(options.sections).length) {
    throw new Error(strings.errors.ambient_context);
  }
  if (!options.appendSystemPrompt.includes(context.expected_bootstrap) || !event.systemPrompt.includes(context.expected_bootstrap)) {
    throw new Error(strings.errors.missing_bootstrap);
  }
  if (context.context_files.some((file) => !event.systemPrompt.includes(file.path) || !event.systemPrompt.includes(file.content))) {
    throw new Error(strings.errors.missing_context_file);
  }
  const names = [...TOOL_NAMES].sort();
  if (!isDeepStrictEqual([...activeTools].sort(), names) || !isDeepStrictEqual([...options.selectedTools].sort(), names)) {
    throw new Error(strings.errors.unexpected_tools);
  }
  const tools = activeTools.map((name) => {
    const expected = resources.tools[name as (typeof TOOL_NAMES)[number]];
    const matches = input.allTools.filter((tool) => tool.name === name);
    const tool = matches[0];
    if (matches.length !== 1 || !tool || tool.description !== expected.description ||
        !isDeepStrictEqual(jsonCopy(tool.parameters), expected.parameters) ||
        !isDeepStrictEqual(tool.promptGuidelines ?? [], expected.promptGuidelines) ||
        options.toolSnippets[name] !== expected.promptSnippet ||
        !isDeepStrictEqual(options.toolGuidelines[name] ?? [], expected.promptGuidelines)) {
      throw new Error(strings.errors.unexpected_tools);
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: jsonCopy(tool.parameters),
      promptSnippet: options.toolSnippets[name],
      promptGuidelines: jsonCopy(tool.promptGuidelines ?? []),
    };
  });
  return {
    _purpose: strings.audit.purpose,
    schema: 1,
    run_id: context.run_id,
    cwd: input.cwd,
    context_path: input.path,
    issue: context.issue,
    base_commit: context.base_commit,
    branch: context.branch,
    context_files: context.context_files,
    expected_bootstrap: context.expected_bootstrap,
    system_prompt: event.systemPrompt,
    task_prompt: event.prompt,
    tools,
    checks: { bootstrap_present: true, explicit_context_present: true, discovered_context_files: 0, discovered_skills: 0 },
    assumptions: strings.audit.assumptions,
  };
}

export function writeEffectiveContext(path: string, audit: ReturnType<typeof effectiveContext>, strings: WorkerStrings): void {
  const destination = join(dirname(dirname(path)), "effective-context.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } catch {
    throw new Error(strings.errors.context_io);
  } finally {
    rmSync(temporary, { force: true });
  }
}
