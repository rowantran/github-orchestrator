/** Purpose: exercise the actual pinned Pi CLI and copied worker bundle offline. Audience: maintainers. Injection: local test provider only; no external model or credentials. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadResources, TOOL_NAMES } from "../resources.ts";
import { assetRoot, contextData, promptBody, readAsset, render } from "./fixtures.ts";

// Loaded before Pi itself. Fail the entire child, rather than letting retries hide an attempted connection.
const networkGuard = `
const { writeSync } = require("node:fs");
const deny = () => { writeSync(2, "NETWORK_ATTEMPT_DENIED_BY_OFFLINE_TEST\\n"); process.exit(89); };
globalThis.fetch = deny;
require("node:net").Socket.prototype.connect = deny;
require("node:tls").connect = deny;
for (const protocol of ["node:http", "node:https"]) {
  require(protocol).request = deny;
  require(protocol).get = deny;
}
require("node:dns").lookup = deny;
require("node:dns").promises.lookup = deny;
require("node:module").syncBuiltinESMExports();
`;

// Pi's faux provider implements a real local AssistantMessageEventStream, with keyless auth ({ auth: {} }).
// It is explicitly loaded from the task snapshot, so these bare SDK imports also test Pi's loader aliases.
const fakeProvider = `
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
export default function (pi) {
  const faux = fauxProvider({ provider: "gho-offline", api: "gho-offline-local", models: [{ id: "audit-test", input: ["text"], reasoning: false }] });
  faux.setResponses([(context, _options, state) => {
    assert.equal(state.callCount, 1);
    const audit = JSON.parse(readFileSync(join(process.cwd(), ".gho/effective-context.json"), "utf8"));
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const tools = getCurrentTools(context.messages);
    const selected = (items) => items.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name));
    // Audit must already exist when the stream starts and agree with Pi's actual provider-facing transcript.
    assert.equal(audit.system_prompt, systemPrompt);
    assert.deepEqual(selected(audit.tools), selected(tools));
    writeFileSync(join(process.cwd(), ".gho/provider-observed.json"), JSON.stringify({
      callCount: state.callCount, systemPrompt, tools, cwd: process.cwd(),
      home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR,
    }));
    return fauxAssistantMessage("offline-runtime-ok");
  }]);
  pi.registerProvider(faux.provider);
}
`;

test("real Pi 0.87.1 loads the copied worker without node_modules and audits actual runtime context offline", { timeout: 45_000 }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gho-pi-runtime-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "worktree");
  const input = join(cwd, ".gho", "input");
  const copiedPi = join(input, "pi");
  const copiedAssets = join(input, "agent-context");
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const temporary = join(root, "tmp");
  for (const path of [copiedPi, copiedAssets, agentDir, temporary]) mkdirSync(path, { recursive: true });
  for (const name of ["worker.ts", "context.ts", "resources.ts"]) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(copiedPi, name));
  }
  for (const name of readdirSync(assetRoot).filter((name) => name.endsWith(".json"))) {
    copyFileSync(new URL(name, assetRoot), join(copiedAssets, name));
  }
  for (let directory = copiedPi; ; directory = dirname(directory)) {
    assert.equal(existsSync(join(directory, "node_modules")), false, `copied worker must not resolve via ${directory}/node_modules`);
    if (dirname(directory) === directory) break;
  }

  const context = contextData();
  context.run_id = "runtime-offline-unique-attempt";
  const schema = JSON.parse(readAsset("result.schema.json"));
  delete schema._purpose;
  const values = {
    issue_url: context.issue.url, issue_title: context.issue.title, issue_body: context.issue.body,
    base_commit: context.base_commit, branch: context.branch, run_id: context.run_id,
    context_files: context.context_files.map((file) => `### ${file.path}\n\n${file.content}`).join("\n\n"),
    result_schema: JSON.stringify(schema, null, 2),
  };
  const system = render("worker-system.md", values);
  const append = promptBody("worker-append.md");
  const task = render("worker-task.md", values);
  for (const [name, content] of Object.entries({
    "system.md": system, "append.md": append, "task.md": task,
    "context.json": JSON.stringify(context), "isara-bootstrap.txt": context.expected_bootstrap,
    "fake-provider.ts": fakeProvider, "no-network.cjs": networkGuard,
  })) writeFileSync(join(input, name), content);

  // Put unwanted resources in both scopes. Explicit inputs and disable flags must exclude them.
  for (const [directory, name] of [[cwd, "AGENTS.md"], [agentDir, "AGENTS.md"], [agentDir, "SYSTEM.md"], [agentDir, "APPEND_SYSTEM.md"]]) {
    writeFileSync(join(directory, name), `UNREVIEWED_AMBIENT_RESOURCE_${name}`);
  }
  const ambientExtensions = join(cwd, ".pi", "extensions");
  mkdirSync(ambientExtensions, { recursive: true });
  writeFileSync(join(ambientExtensions, "must-not-load.ts"), 'throw new Error("AMBIENT_EXTENSION_LOADED");');

  const packageRoot = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
  const piPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(piPackage.version, "0.87.1");
  const cli = join(packageRoot, piPackage.bin.pi);
  const args = [
    // Isara normally prepends this append argument. Do not run Isara's credential-minting launcher here.
    "--append-system-prompt", join(input, "isara-bootstrap.txt"),
    // Pi portion of Runner.argv, replacing only the provider extension/provider/model and choosing off thinking.
    "--mode", "json", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-approve", "--no-builtin-tools",
    "--extension", join(input, "fake-provider.ts"), "--extension", join(copiedPi, "worker.ts"),
    "--provider", "gho-offline", "--model", "audit-test", "--thinking", "off",
    "--system-prompt", join(input, "system.md"), "--append-system-prompt", join(input, "append.md"),
    "--session-dir", join(cwd, ".gho", "sessions"), "--session-id", context.run_id,
    "--gho-context", join(input, "context.json"), `@${join(input, "task.md")}`,
  ];
  const child = spawnSync(process.execPath, ["--require", join(input, "no-network.cjs"), cli, ...args], {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    // Deliberately do not inherit credentials, NODE_PATH, NODE_OPTIONS, or the caller's Pi/session state.
    env: {
      HOME: home, PI_CODING_AGENT_DIR: agentDir, TMPDIR: temporary,
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", NO_COLOR: "1", CI: "1",
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    },
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, `Pi stderr:\n${child.stderr}\nPi stdout:\n${child.stdout}`);
  assert.doesNotMatch(child.stderr, /NETWORK_ATTEMPT_DENIED|AMBIENT_EXTENSION_LOADED|Extension error|Failed to load extension/);
  const events = child.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert.equal(events[0].type, "session");
  assert.equal(events[0].cwd, cwd);
  assert.equal(events[0].id, context.run_id);
  assert.ok(events.some((event) => event.type === "agent_settled"));
  const assistant = events.filter((event) => event.type === "message_end" && event.message.role === "assistant").at(-1)?.message;
  assert.equal(assistant?.stopReason, "stop", JSON.stringify(assistant));
  assert.equal(assistant.provider, "gho-offline");
  assert.deepEqual(assistant.content, [{ type: "text", text: "offline-runtime-ok" }]);

  const audit = JSON.parse(readFileSync(join(cwd, ".gho", "effective-context.json"), "utf8"));
  const observed = JSON.parse(readFileSync(join(cwd, ".gho", "provider-observed.json"), "utf8"));
  assert.equal(observed.callCount, 1);
  assert.equal(observed.home, home);
  assert.equal(observed.agentDir, agentDir);
  assert.equal(audit.run_id, context.run_id);
  assert.equal(audit.cwd, cwd);
  assert.equal(audit.context_path, join(input, "context.json"));
  assert.equal(audit.system_prompt, observed.systemPrompt);
  for (const content of [system, append, context.expected_bootstrap, context.context_files[0].content]) assert.ok(audit.system_prompt.includes(content));
  assert.ok(audit.task_prompt.includes(task));
  assert.ok(audit.task_prompt.includes("literal {{branch}}"));
  assert.doesNotMatch(audit.system_prompt, /UNREVIEWED_AMBIENT_RESOURCE|<!-- Purpose:/);
  assert.deepEqual(audit.checks, { bootstrap_present: true, explicit_context_present: true, discovered_context_files: 0, discovered_skills: 0 });
  const expectedTools = loadResources().tools;
  assert.deepEqual(audit.tools.map((tool: { name: string }) => tool.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of audit.tools) {
    const { label: _label, ...metadata } = expectedTools[tool.name as (typeof TOOL_NAMES)[number]];
    assert.deepEqual(tool, metadata);
  }
  assert.equal(existsSync(join(input, "effective-context.json")), false);
  assert.ok(readdirSync(join(cwd, ".gho", "sessions")).some((name) => name.endsWith(".jsonl")));
});
