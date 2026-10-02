import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PiAgent, type PiAgentOptions, type RpcEvent } from "../orchestrator/rpc.js";
import { acquireLock } from "../orchestrator/store.js";

const root = new URL(existsSync(new URL("../package.json", import.meta.url)) ? "../" : "../../", import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, root));
const hasPi = spawnSync("which", ["pi"], { encoding: "utf8" }).status === 0;
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") return !/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    return true;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
function notifications(events: RpcEvent[]): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
    .flatMap((event) => { try { return [JSON.parse(String(event.message)) as Record<string, unknown>]; } catch { return []; } });
}

test("installed normal Pi RPC loads settings, providers, context, skills, codemode and resumes exact session without a model call", {
  skip: !hasPi, timeout: 60_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gho-real-pi-"));
  const agents: PiAgent[] = [];
  let requests = 0;
  const provider = createServer((_request, response) => { requests++; response.writeHead(500).end(); });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  assert(address && typeof address !== "string");
  t.after(async () => {
    await Promise.all(agents.map((agent) => agent.close()));
    await new Promise<void>((done) => provider.close(() => done()));
    await rm(cwd, { recursive: true, force: true });
  });
  for (const directory of ["agent", "home", "sessions", ".pi/prompts", ".pi/skills/fixture"])
    await mkdir(join(cwd, directory), { recursive: true });
  await writeFile(join(cwd, "agent", "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "first", defaultThinkingLevel: "medium",
    defaultTools: ["+codemode"], cacheWarming: "off", steeringMode: "all",
    extensions: [path("tests/fixtures/fake-pi-probe.mjs")],
  }));
  await writeFile(join(cwd, "agent", "models.json"), JSON.stringify({ providers: {
    fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only-dummy-key", models: [
      { id: "first", reasoning: true, contextWindow: 32000, maxTokens: 1000 },
      { id: "second/nested", reasoning: true, contextWindow: 32000, maxTokens: 1000 },
    ] },
  } }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    steeringMode: "one-at-a-time", defaultThinkingLevel: "low",
    extensions: [path("tests/fixtures/fake-pi-project-probe.mjs")],
  }));
  await writeFile(join(cwd, "AGENTS.md"), "fixture-project-context-sentinel\n");
  await writeFile(join(cwd, "agent", "AGENTS.md"), "fixture-user-context-sentinel\n");
  await writeFile(join(cwd, "extra.md"), "fixture-appended-context-sentinel\n");
  await writeFile(join(cwd, ".pi", "prompts", "fixture-template.md"), "---\ndescription: fixture-template\n---\nfixture-template\n");
  await writeFile(join(cwd, ".pi", "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: fixture-skill-sentinel\n---\nfixture-skill\n");
  const sessionId = "rpc-smoke-fixed-id";
  const sessionFile = join(cwd, "sessions", `fixture_${sessionId}.jsonl`);
  const timestamp = new Date().toISOString();
  await writeFile(sessionFile, [
    { type: "session", version: 3, id: sessionId, timestamp, cwd },
    { type: "message", id: "fixture01", parentId: null, timestamp, message: { role: "user", content: "fixture-saved-message", timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const options: PiAgentOptions = {
    cwd, sessionId, sessionDir: join(cwd, "sessions"), role: "implementer", instructionsPath: join(cwd, "extra.md"),
    phaseToken: "phase-smoke-one", reportPath: join(cwd, "report-one.json"),
    // One-shot trust is explicit test setup, never an automatic driver approval.
    command: process.execPath, args: [path("tests/fixtures/fake-pi-cli.mjs"), "--approve"],
    startupTimeoutMs: 25_000, commandTimeoutMs: 10_000, shutdownTimeoutMs: 1000,
  };
  const first = new PiAgent(options);
  agents.push(first);
  const events: RpcEvent[] = [];
  first.onEvent((event) => events.push(event));
  try { await first.start(); } catch (error) { assert.fail(`${String(error)}\n${first.stderr}`); }
  const state = await first.getState();
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.sessionFile, sessionFile);
  assert.equal(state.model?.provider, "fixture");
  assert.equal(state.model?.id, "first");
  assert.equal(state.thinkingLevel, "low");
  const commands = await first.request("get_commands") as { commands: Array<{ name: string }> };
  for (const name of ["gho-probe", "gho-probe-report", "gho-probe-dialog", "gho-project-probe", "fixture-template", "skill:fixture"])
    assert(commands.commands.some((command) => command.name === name), `Missing command ${name}`);
  assert.deepEqual(await first.prompt("/gho-project-probe"), { disposition: "handled" });
  assert(notifications(events).some((event) => event.projectExtension === true));
  assert.deepEqual(await first.prompt("/gho-probe"), { disposition: "handled" });
  const probe = notifications(events).find((event) => event.probe);
  assert(probe);
  const systemPrompt = String(probe.systemPrompt);
  for (const sentinel of ["fixture-project-context-sentinel", "fixture-user-context-sentinel", "fixture-appended-context-sentinel", "fixture-skill-sentinel"])
    assert(systemPrompt.includes(sentinel), `Missing context ${sentinel}`);
  assert((probe.tools as string[]).includes("codemode"));
  assert((probe.tools as string[]).includes("gho_report"));
  assert((probe.tools as string[]).includes("read"));
  assert.equal(probe.trusted, true);
  assert.deepEqual(probe.settings, { steeringMode: "one-at-a-time" });
  assert((await first.getMessages()).some((message) => (message as Record<string, unknown>).content === "fixture-saved-message"));

  const switched = await first.setModel("fixture/second/nested:high");
  assert.equal(switched.model?.id, "second/nested");
  assert.equal(switched.thinkingLevel, "high");
  assert.equal(switched.sessionFile, sessionFile);

  const dialogPrompt = first.prompt("/gho-probe-dialog");
  let dialog: RpcEvent | undefined;
  for (let i = 0; i < 100; i++) {
    dialog = events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
    if (dialog) break;
    await delay(10);
  }
  assert(dialog);
  await first.respond({ id: dialog.id, confirmed: false });
  assert.deepEqual(await dialogPrompt, { disposition: "handled" });
  assert(notifications(events).some((event) => event.dialogAnswer === false));

  const report = { kind: "skeleton_ready", summary: "fixture-summary", findings: ["fixture-finding"] };
  await first.prompt(`/gho-probe-report ${JSON.stringify(report)}`);
  assert.deepEqual(JSON.parse(await readFile(options.reportPath, "utf8")), { phaseToken: options.phaseToken, ...report });
  assert(notifications(events).some((event) => (event.reportResult as Record<string, unknown> | undefined)?.terminate === true));
  // An exact duplicate is safe; conflicting or role-invalid results cannot replace the first report.
  await first.prompt(`/gho-probe-report ${JSON.stringify(report)}`);
  await first.prompt(`/gho-probe-report ${JSON.stringify({ kind: "needs_input", summary: "different" })}`);
  await first.prompt(`/gho-probe-report ${JSON.stringify({ kind: "review_passed", summary: "fixture" })}`);
  await first.prompt(`/gho-probe-report ${JSON.stringify({ kind: "invalid", summary: "fixture" })}`);
  assert(notifications(events).some((event) => String(event.reportError).includes("Conflicting")));
  assert(notifications(events).some((event) => String(event.reportError).includes("role")));
  assert(notifications(events).some((event) => String(event.reportError).includes("Invalid")));
  assert.deepEqual(JSON.parse(await readFile(options.reportPath, "utf8")), { phaseToken: options.phaseToken, ...report });
  assert.equal((await readdir(cwd)).some((name) => name.endsWith(".tmp")), false);
  await first.close();

  const second = new PiAgent({ ...options, phaseToken: "phase-smoke-two", reportPath: join(cwd, "report-two.json") });
  agents.push(second);
  second.subscribe((event) => events.push(event));
  await second.start();
  const resumed = await second.getState();
  assert.equal(resumed.sessionFile, sessionFile);
  assert.equal(resumed.model?.id, "second/nested");
  assert.equal(resumed.thinkingLevel, "high");
  assert((await second.getMessages()).some((message) => (message as Record<string, unknown>).content === "fixture-saved-message"));
  await second.close();

  const third = new PiAgent({
    ...options, phaseToken: "phase-smoke-three", reportPath: join(cwd, "report-three.json"), commandTimeoutMs: 150,
  });
  agents.push(third);
  third.subscribe((event) => events.push(event));
  await third.start();
  for (const method of ["prompt", "steer"] as const) {
    const offset = events.length;
    const accepted = third[method]("fixture-input-hook");
    void accepted.catch(() => {});
    let inputDialog: RpcEvent | undefined;
    for (let i = 0; i < 100; i++) {
      inputDialog = events.slice(offset).find((event) => event.type === "extension_ui_request" && event.method === "confirm");
      if (inputDialog) break;
      await delay(10);
    }
    assert(inputDialog, `Real Pi ${method} must expose its input-hook confirmation`);
    await delay(350); // Human input must not consume the 150 ms acceptance deadline.
    assert.equal(events.slice(offset).some((event) => event.type === "driver_error"), false);
    assert.equal((await third.getState()).sessionId, sessionId);
    await third.respond({ id: inputDialog.id, confirmed: false });
    assert.deepEqual(await accepted, { disposition: "handled" });
    assert(notifications(events.slice(offset)).some((event) => event.inputDialogAnswer === false));
  }
  await third.close();
  assert.equal((await readdir(options.sessionDir)).filter((name) => name.endsWith(".jsonl")).length, 1);
  assert.equal(requests, 0, "Smoke test must never call a provider");
  assert.equal(events.some((event) => event.type === "agent_start"), false);
});

test("independent Pi processes lock the whole worktree across roles and release ownership on close or death", {
  skip: !hasPi, timeout: 30_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gho-pi-writer-lock-"));
  const agents: PiAgent[] = [];
  t.after(async () => {
    await Promise.all(agents.map((agent) => agent.close()));
    await rm(cwd, { recursive: true, force: true });
  });
  for (const directory of ["agent", "home", "sessions"]) await mkdir(join(cwd, directory));
  await writeFile(join(cwd, "agent", "settings.json"), JSON.stringify({
    cacheWarming: "off", extensions: [path("tests/fixtures/fake-pi-project-probe.mjs")],
  }));
  const childPid = async (agent: PiAgent): Promise<number> => {
    const events: RpcEvent[] = [];
    const unsubscribe = agent.subscribe((event) => events.push(event));
    try {
      const commands = await agent.request("get_commands") as { commands: Array<{ name: string }> };
      assert(commands.commands.some((command) => command.name === "gho-project-probe"));
      await agent.prompt("/gho-project-probe");
      const result = notifications(events).find((event) => event.projectExtension);
      assert(result);
      assert.equal(result.inheritedGuard, true);
      assert.equal(result.helperInheritedGuard, false, "Ordinary Pi helpers must not inherit the writer descriptor");
      assert.notEqual(result.pid, process.pid);
      return Number(result.pid);
    } finally { unsubscribe(); }
  };
  const options: PiAgentOptions = {
    cwd, sessionId: "writer-implementer", sessionDir: join(cwd, "sessions"), role: "implementer",
    reportPath: join(cwd, ".gho/reports/implementation.json"), phaseToken: "writer-phase-one",
    command: process.execPath, args: [path("tests/fixtures/fake-pi-cli.mjs")],
    startupTimeoutMs: 15_000, shutdownTimeoutMs: 1000,
  };
  const create = (overrides: Partial<PiAgentOptions> = {}) => {
    const agent = new PiAgent({ ...options, ...overrides });
    agents.push(agent);
    return agent;
  };
  const metadataPath = join(cwd, ".gho/writer/service.lock");
  const first = create();
  await first.start();
  const firstOwner = JSON.parse(await readFile(metadataPath, "utf8")) as { pid: number };
  assert.equal(firstOwner.pid, process.pid, "The service acquires ownership before spawning Pi");
  assert(await alive(await childPid(first)));
  const reviewer: Partial<PiAgentOptions> = {
    role: "reviewer", sessionId: "writer-reviewer", sessionDir: join(cwd, "reviewer-sessions"),
    phaseToken: "writer-phase-two", reportPath: join(cwd, ".gho/reports/review.json"),
  };
  const contender = create(reviewer);
  const events: RpcEvent[] = [];
  contender.subscribe((event) => events.push(event));
  // A different role AND session directory bypass the driver's in-process session-ID guard.
  await assert.rejects(contender.start(), /kernel lock is held/);
  assert.equal(events.some((event) => event.type === "driver_ready"), false);
  assert.equal((await first.getState()).sessionId, options.sessionId);
  assert.equal((JSON.parse(await readFile(metadataPath, "utf8")) as { pid: number }).pid, firstOwner.pid);
  await first.close();
  assert.equal(existsSync(metadataPath), false);
  const second = create(reviewer);
  await second.start();
  assert.equal((await second.getState()).sessionId, reviewer.sessionId);
  const secondPid = await childPid(second);
  process.kill(secondPid, "SIGKILL"); // No session_shutdown hook can release this lock.
  await second.close();
  assert.equal(await alive(secondPid), false);
  const third = create({ ...reviewer, phaseToken: "writer-phase-three" });
  await third.start();
  assert.equal((await third.getState()).sessionId, reviewer.sessionId);
  await third.close();
  assert.equal(existsSync(metadataPath), false);
});

test("rejected same-session startup cannot change the saved transcript before session_start", {
  skip: !hasPi, timeout: 30_000,
}, async (t) => {
  for (const withConversation of [true, false]) {
    await t.test(withConversation ? "saved conversation" : "saved metadata-only session", async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "gho-pi-startup-writes-"));
      const owners: Array<{ child: ChildProcessWithoutNullStreams; exited: Promise<void> }> = [];
      let providerRequests = 0;
      const provider = createServer((_request, response) => { providerRequests++; response.writeHead(500).end(); });
      await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
      const address = provider.address();
      assert(address && typeof address !== "string");
      t.after(async () => {
        for (const { child, exited } of owners) {
          child.stdin.end();
          const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
          try { await exited; } finally { clearTimeout(timer); }
        }
        await new Promise<void>((done) => provider.close(() => done()));
        await rm(cwd, { recursive: true, force: true });
      });
      for (const directory of ["agent", "home", "sessions"]) await mkdir(join(cwd, directory));
      await writeFile(join(cwd, "agent/settings.json"), JSON.stringify({ cacheWarming: "off" }));
      await writeFile(join(cwd, "agent/models.json"), JSON.stringify({ providers: {
        fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only-dummy-key",
          models: ["first", "second"].map((id) => ({ id, reasoning: true, contextWindow: 32000, maxTokens: 1000 })) },
      } }));
      const sessionId = "same-session-startup", timestamp = new Date().toISOString();
      const sessionFile = join(cwd, "sessions", `fixture_${sessionId}.jsonl`);
      const entries: unknown[] = [
        { type: "session", version: 3, id: sessionId, timestamp, cwd },
        { type: "model_change", id: "model001", parentId: null, timestamp, provider: "fixture", modelId: "first" },
        { type: "thinking_level_change", id: "think001", parentId: "model001", timestamp, thinkingLevel: "medium" },
      ];
      if (withConversation) entries.push({ type: "message", id: "user0001", parentId: "think001", timestamp,
        message: { role: "user", content: "fixture-saved-message", timestamp: Date.now() } });
      await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const startOwner = async (name: string, model: string): Promise<Record<string, unknown>> => {
        const options: PiAgentOptions = {
          cwd, sessionId, sessionDir: join(cwd, "sessions"), role: "implementer", model,
          reportPath: join(cwd, ".gho/reports", `${name}.json`), phaseToken: name,
          command: process.execPath, args: [path("tests/fixtures/fake-pi-cli.mjs")], startupTimeoutMs: 15_000,
        };
        const optionsPath = join(cwd, `${name}.json`);
        await writeFile(optionsPath, JSON.stringify(options));
        const child = spawn(process.execPath, [path("tests/fixtures/fake-pi-startup-owner.mjs"), optionsPath], {
          cwd, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: join(cwd, "home") },
        });
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        owners.push({ child, exited });
        let stdout = "", stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        return new Promise((done, reject) => {
          const timer = setTimeout(() => reject(new Error(`Startup harness timed out: ${stderr}`)), 20_000);
          child.once("error", (error) => { clearTimeout(timer); reject(error); });
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            const newline = stdout.indexOf("\n");
            if (newline >= 0) {
              clearTimeout(timer);
              try { done(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>); } catch (error) { reject(error); }
            }
          });
          child.once("exit", () => {
            clearTimeout(timer);
            if (!stdout.includes("\n")) reject(new Error(`Startup harness exited without a result: ${stderr}`));
          });
        });
      };
      const first = await startOwner("first-owner", "fixture/first:medium");
      assert.equal(first.ready, true, JSON.stringify(first));
      const before = await readFile(sessionFile, "utf8");
      const contender = await startOwner("rejected-owner", "fixture/second:high");
      assert.equal(contender.ready, false, JSON.stringify(contender));
      assert.match(String(contender.error), /kernel lock is held/);
      const after = await readFile(sessionFile, "utf8");
      const appended = after.slice(before.length).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      t.diagnostic(JSON.stringify({ beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after), appended }));
      assert.equal(providerRequests, 0);
      assert.equal(after, before, "A rejected writer must not append startup model/thinking metadata");
    });
  }
});

test("service death leaves Pi ownership held through all shutdown hooks, then closes detached shells without model work", {
  skip: !hasPi, timeout: 30_000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gho-pi-owner-crash-"));
  let childPid: number | undefined, shellPid: number | undefined;
  const optionsPath = join(cwd, "options.json"), resultPath = join(cwd, "result.json");
  for (const directory of ["agent", "home", "sessions"]) await mkdir(join(cwd, directory));
  await writeFile(join(cwd, "agent", "settings.json"), JSON.stringify({
    cacheWarming: "off", extensions: [path("tests/fixtures/fake-pi-project-probe.mjs"), path("tests/fixtures/fake-pi-background-probe.mjs")],
  }));
  const options: PiAgentOptions = {
    cwd, sessionId: "owner-crash-session", sessionDir: join(cwd, "sessions"), role: "implementer",
    reportPath: join(cwd, "report.json"), phaseToken: "crash-phase",
    // No forwarding process: after owner death, only Pi itself can keep fd 3 alive.
    command: "pi", startupTimeoutMs: 15_000,
  };
  await writeFile(join(cwd, "shutdown.hold"), "");
  await writeFile(optionsPath, JSON.stringify(options));
  const owner = spawn(process.execPath, [path("tests/fixtures/fake-pi-crash-owner.mjs"), optionsPath, resultPath], {
    cwd, stdio: ["ignore", "ignore", "pipe"], env: {
      PATH: process.env.PATH, HOME: join(cwd, "home"), PI_CODING_AGENT_DIR: join(cwd, "agent"),
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    },
  });
  let stderr = "";
  owner.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = new Promise<void>((done) => owner.once("exit", () => done()));
  t.after(async () => {
    owner.kill("SIGKILL");
    for (const pid of [childPid, shellPid]) if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already stopped. */ } }
    await rm(cwd, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && (!existsSync(resultPath) || !existsSync(join(cwd, "background.pid"))); i++) {
    assert.equal(owner.exitCode, null, stderr);
    await delay(50);
  }
  assert(existsSync(resultPath), stderr || "Crash-test Pi did not become ready");
  const result = JSON.parse(await readFile(resultPath, "utf8")) as { pid: number; notifications: Array<Record<string, unknown>> };
  childPid = result.pid;
  shellPid = Number(await readFile(join(cwd, "background.pid"), "utf8"));
  const piPid = Number(result.notifications.find((event) => event.projectExtension)?.pid);
  assert(Number.isInteger(piPid) && piPid > 0);
  assert(result.notifications.some((event) => event.backgroundShell === true));
  assert.equal(childPid, piPid, "This regression must run Pi directly without a wrapper retaining fd 3");
  assert(await alive(piPid));
  assert(await alive(shellPid));
  owner.kill("SIGKILL"); // No driver.close(): only the kernel closes the dead owner's RPC pipes.
  await exit;
  for (let i = 0; i < 200 && !existsSync(join(cwd, "shutdown.started")); i++) await delay(10);
  assert(existsSync(join(cwd, "shutdown.started")), stderr || "Pi must enter extension cleanup");
  assert(await alive(piPid));
  assert(await alive(shellPid), "Background work remains owned until its shutdown hook finishes");
  await assert.rejects(async () => {
    const unexpectedOwner = await acquireLock(join(cwd, ".gho", "writer"));
    await unexpectedOwner();
  }, /kernel lock is held/, "A later shutdown hook must not overlap a replacement writer");
  await writeFile(join(cwd, "shutdown.release"), "");
  for (let i = 0; i < 100 && (await alive(piPid) || await alive(shellPid)); i++) await delay(50);
  assert.equal(await alive(piPid), false, "Normal Pi must exit after its stdin owner dies");
  assert.equal(await alive(shellPid), false, "Extension cleanup must stop detached shell groups on session_shutdown");
  const recovered = await acquireLock(join(cwd, ".gho", "writer"));
  await recovered(); // Stale metadata is not authority after the inherited descriptor is closed by exit.
});
