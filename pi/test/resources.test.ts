/** Purpose: validate the reviewed resource surface and renderer contract. Audience: maintainers. Injection: none. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool,
} from "@earendil-works/pi-coding-agent";
import { loadResources, TOOL_NAMES } from "../resources.ts";
import { assetRoot, promptBody, readAsset, render } from "./fixtures.ts";

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description").map(([key, item]) => [key, withoutDescriptions(item)]));
  return value;
}
function requireSchemaDescriptions(schema: Record<string, unknown>): void {
  if (schema.properties) {
    for (const value of Object.values(schema.properties as Record<string, Record<string, unknown>>)) {
      assert.equal(typeof value.description, "string");
      assert.ok((value.description as string).trim());
      requireSchemaDescriptions(value);
    }
  }
  if (schema.items) requireSchemaDescriptions(schema.items as Record<string, unknown>);
}

test("every agent-context asset identifies purpose, audience, and injection boundary", () => {
  for (const name of readdirSync(assetRoot).filter((name) => name.endsWith(".json") || name.endsWith(".md"))) {
    const source = readAsset(name);
    const metadata = name.endsWith(".json") ? JSON.parse(source)._purpose : source.match(/^<!--[^]*?-->/)?.[0];
    assert.equal(typeof metadata, "string", name);
    for (const field of ["Purpose:", "Audience:", "Injection:"]) assert.ok(metadata.includes(field), `${name}: ${field}`);
  }
  const skill = readAsset("planner/SKILL.md");
  assert.match(skill, /^---\nname: github-orchestrator-planner\n/);
  assert.match(skill, /purpose:.*\n  audience:.*\n  injection:/);
  for (const command of ["gho task create --title", "--body-file", "--blocked-by", "--note", "gho status --json", "gho inspect ISSUE", "gho context ISSUE", "gho run"]) {
    assert.ok(skill.includes(command), command);
  }
  assert.match(skill, /Approval is operator-only/);
});

test("owned schemas match the pinned Pi tool input shapes and describe every parameter", () => {
  const resources = loadResources();
  const factories = [createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool];
  assert.deepEqual(Object.keys(resources.tools), TOOL_NAMES);
  for (const create of factories) {
    const native = create(process.cwd());
    const definition = resources.tools[native.name as (typeof TOOL_NAMES)[number]];
    const schema = JSON.parse(JSON.stringify(native.parameters));
    assert.deepEqual(withoutDescriptions(definition.parameters), withoutDescriptions(schema), native.name);
    requireSchemaDescriptions(JSON.parse(JSON.stringify(definition.parameters)));
    for (const key of ["name", "label", "description", "promptSnippet"] as const) assert.ok(definition[key].trim(), `${native.name}.${key}`);
  }
});

test("the renderer contract exports only the eight documented placeholders", () => {
  const names = ["worker-system.md", "worker-append.md", "worker-task.md"];
  const placeholders = new Set(names.flatMap((name) => [...promptBody(name).matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1])));
  assert.deepEqual([...placeholders].sort(), ["issue_url", "issue_title", "issue_body", "base_commit", "branch", "run_id", "context_files", "result_schema"].sort());
  assert.equal(placeholders.size, 8);
  for (const name of names) assert.ok(promptBody(name).length < 2600, `${name} should stay brief`);
  assert.throws(() => render("worker-task.md", {}), /missing placeholder/);
  assert.ok(!promptBody("worker-append.md").includes("{{"));
  const system = promptBody("worker-system.md");
  assert.match(system, /Do not commit, push, merge/);
  assert.match(system, /Do not run gho commands/);
  assert.match(system, /Never report the issue complete/);
  assert.match(system, /write only result.json/);
});

test("result schema is minimal, rejects extra fields, and distinguishes blockers from review handoff", () => {
  const schema = JSON.parse(readAsset("result.schema.json"));
  delete schema._purpose;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["status", "summary", "tests", "blockers"]);
  assert.deepEqual(Object.keys(schema.properties), schema.required);
  assert.deepEqual(schema.properties.status.enum, ["ready_for_review", "blocked"]);
  assert.equal(schema.properties.summary.minLength, 1);
  assert.equal(schema.properties.tests.type, "array");
  assert.equal(schema.properties.tests.items.type, "string");
  assert.equal(schema.allOf[0].if.properties.status.const, "blocked");
  assert.equal(schema.allOf[0].then.properties.blockers.minItems, 1);
  assert.equal(schema.allOf[1].if.properties.status.const, "ready_for_review");
  assert.equal(schema.allOf[1].then.properties.blockers.maxItems, 0);
  assert.ok(!JSON.stringify(schema).includes("_purpose"));
});

test("Pi runtime used by the offline tests is exactly the documented pin", () => {
  const packageFile = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
  assert.equal(JSON.parse(readFileSync(packageFile, "utf8")).version, "0.87.1");
  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(own.devDependencies["@earendil-works/pi-coding-agent"], "0.87.1");
});
