import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { PiAgent, type PiAgentOptions, type RpcEvent } from "../orchestrator/rpc.js";
import type { RpcAgent } from "../orchestrator/types.js";

const root = new URL(existsSync(new URL("../package.json", import.meta.url)) ? "../" : "../../", import.meta.url);
const fixture = fileURLToPath(new URL("tests/fixtures/fake-pi.mjs", root));
async function setup(t: TestContext, extra: Partial<PiAgentOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "gho-rpc-"));
  const options: PiAgentOptions = {
    cwd, sessionId: "stable-session", sessionDir: join(cwd, "sessions"), role: "implementer",
    reportPath: join(cwd, "report.json"), phaseToken: "phase-one", command: process.execPath,
    args: [fixture, "--fake-mode", "normal"], startupTimeoutMs: 2000, commandTimeoutMs: 1000, shutdownTimeoutMs: 100,
    ...extra,
  };
  const agent = new PiAgent(options);
  const events: RpcEvent[] = [];
  agent.subscribe((event) => events.push(event));
  t.after(async () => { await agent.close(); await rm(cwd, { recursive: true, force: true }); });
  return { agent, options, events, cwd };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); }
  assert.fail("Expected event did not arrive");
}

// This assignment checks the service's public structural contract at compile time.
const compatible = (agent: PiAgent): RpcAgent => agent;

test("normal CLI flags, explicit stable identity, resources, report environment and idempotent start", async (t) => {
  const { agent, cwd, options } = await setup(t);
  const instructions = join(cwd, "instructions.md");
  await writeFile(instructions, "fixture-instructions");
  const configured = new PiAgent({ ...options, instructionsPath: instructions });
  t.after(() => configured.close());
  compatible(configured);
  assert.strictEqual(configured.start(), configured.start());
  await configured.start();
  assert.equal(typeof configured.pid, "number");
  const info = await configured.request("fixture_inspect") as Record<string, unknown>;
  const args = info.args as string[];
  assert.equal(args.includes("--continue"), false);
  assert.equal(args.includes("--no-extensions"), false);
  assert.equal(args.includes("--no-context-files"), false);
  assert.equal(args[args.indexOf("--session-id") + 1], "stable-session");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], instructions);
  assert.equal(info.phaseToken, options.phaseToken);
  assert.equal(info.reportPath, options.reportPath);
  assert.equal(info.role, "implementer");
  await assert.rejects(agent.start(), /already has a live driver/);
  await configured.close();
  assert.equal((await readdir(options.sessionDir)).length, 1);
});

test("correlates out-of-order replies; prompts return on acceptance, not agent_end", async (t) => {
  const { agent, events } = await setup(t);
  await agent.start();
  const [messages, state] = await Promise.all([agent.getMessages(), agent.getState()]);
  assert.deepEqual(messages, []);
  assert.equal(state.sessionId, "stable-session");
  assert.deepEqual(await agent.prompt("first"), { disposition: "started" });
  await waitFor(() => events.some((event) => event.type === "agent_end"));
  assert.equal(agent.settled, false);
  assert.deepEqual(await agent.steer("second"), { disposition: "queued" });
  await agent.request("fixture_settle");
  assert.equal(agent.settled, true);
  assert.deepEqual(await agent.getMessages(), [{ role: "user", content: "first" }]);
  assert.deepEqual(await agent.prompt("handled"), { disposition: "handled" });
  assert.equal(agent.settled, true);
});

test("LF-only framing preserves Unicode separators and fragmented multibyte characters", async (t) => {
  const { agent, events } = await setup(t);
  await agent.start();
  await agent.prompt("unicode");
  const event = events.find((entry) => entry.type === "message_update");
  assert.deepEqual(event?.assistantMessageEvent, { type: "text_delta", delta: "a\u2028b\u2029c😀" });
});

test("restart resumes the exact saved session, with new phase environment and no duplicate session", async (t) => {
  const { agent, options } = await setup(t);
  await agent.start();
  const first = await agent.getState();
  await agent.prompt("persisted");
  await agent.abort();
  await agent.close();
  const next = new PiAgent({ ...options, phaseToken: "phase-two", reportPath: join(options.cwd, "report-two.json") });
  t.after(() => next.close());
  await next.start();
  assert.equal((await next.getState()).sessionFile, first.sessionFile);
  assert.deepEqual(await next.getMessages(), [{ role: "user", content: "persisted" }]);
  assert.equal((await readdir(options.sessionDir)).length, 1);
  assert.equal((await next.request("fixture_inspect") as Record<string, unknown>).phaseToken, "phase-two");
  await next.close(); // Release its worktree lock before setup removes the temporary directory.
});

test("setModel resolves provider/model[:thinking] including nested and colon model IDs", async (t) => {
  const { agent } = await setup(t);
  await agent.start();
  const before = await agent.getState();
  const switched = await agent.setModel("fixture/second/nested:high");
  assert.equal(switched.model?.id, "second/nested");
  assert.equal(switched.thinkingLevel, "high");
  assert.equal(switched.sessionFile, before.sessionFile);
  const local = await agent.setModel("local/model:7b");
  assert.equal(local.model?.id, "model:7b");
  await assert.rejects(agent.setModel("missing/model"), /Model not found/);
  await agent.prompt("busy");
  await assert.rejects(agent.setModel("fixture/second/nested"), /settled/);
});

test("model switch verifies effective thinking rather than accepting silent clamping", async (t) => {
  const { agent } = await setup(t, { args: [fixture, "--fake-mode", "ignore-thinking"] });
  await agent.start();
  await assert.rejects(agent.setModel("fixture/second/nested:high"), /did not apply/);
});

test("dialogs are forwarded and never automatically approved", async (t) => {
  const { agent, events, cwd } = await setup(t);
  await agent.start();
  await agent.prompt("dialog");
  const dialog = events.find((event) => event.id === "approval");
  assert.equal(dialog?.type, "extension_ui_request");
  await delay(30);
  assert.equal((await readFile(join(cwd, "commands.jsonl"), "utf8")).includes("extension_ui_response"), false);
  await assert.rejects(agent.respond({ id: "unknown", confirmed: true }), /Unknown/);
  await assert.rejects(agent.respond({ id: "approval", value: "yes" }), /Invalid/);
  await agent.respond({ id: "approval", confirmed: false });
  await waitFor(() => events.some((event) => event.type === "fixture_dialog_answer"));
  assert.deepEqual(events.find((event) => event.type === "fixture_dialog_answer")?.answer,
    { id: "approval", type: "extension_ui_response", confirmed: false });
});

for (const method of ["prompt", "steer"] as const) {
  for (const cancelled of [false, true]) {
    test(`${method} input confirmation pauses acceptance deadline until ${cancelled ? "cancel" : "answer"}`, async (t) => {
      const { agent, events } = await setup(t, { commandTimeoutMs: 70 });
      await agent.start();
      const accepted = agent[method]("input-confirm");
      void accepted.catch(() => {});
      await waitFor(() => events.some((event) => event.method === "confirm"));
      const dialog = events.find((event) => event.method === "confirm")!;
      await delay(220);
      assert.equal(events.some((event) => event.type === "driver_error"), false);
      assert.equal((await agent.getState()).sessionId, "stable-session");
      await agent.respond({ id: dialog.id, ...(cancelled ? { cancelled: true } : { confirmed: true }) });
      assert.deepEqual(await accepted, { disposition: "handled" });
    });
  }
}

test("bootstrap dialog accepts a validated answer before start resolves and pauses only its startup deadline", async (t) => {
  const { agent, events } = await setup(t, { args: [fixture, "--fake-mode", "bootstrap-dialog"], startupTimeoutMs: 90, commandTimeoutMs: 70 });
  const started = agent.start();
  void started.catch(() => {});
  await waitFor(() => events.some((event) => event.id === "bootstrap"));
  await delay(250);
  assert.equal(events.some((event) => event.type === "driver_error"), false);
  await assert.rejects(agent.respond({ id: "unknown", confirmed: true }), /Unknown/);
  await agent.respond({ id: "bootstrap", confirmed: false });
  await started;
  assert.equal((await agent.getState()).sessionId, "stable-session");
});

test("a dialog's UI timeout can resolve input without an explicit answer", async (t) => {
  const { agent } = await setup(t, { commandTimeoutMs: 70 });
  await agent.start();
  assert.deepEqual(await agent.prompt("input-timeout"), { disposition: "handled" });
});

for (const message of ["input-timeout-hang", "input-start-hang", "input-answer-hang"]) {
  test(`acceptance resumes a finite deadline after ${message}`, async (t) => {
    const { agent, events } = await setup(t, { commandTimeoutMs: 70 });
    await agent.start();
    const accepted = agent.prompt(message);
    const rejected = assert.rejects(accepted, /timed out: prompt/);
    await waitFor(() => events.some((event) => event.method === "confirm"));
    if (message === "input-answer-hang") {
      await delay(220);
      const dialog = events.find((event) => event.method === "confirm")!;
      await agent.respond({ id: dialog.id, confirmed: true });
    }
    await rejected;
    await agent.close();
  });
}

test("a completed input response cannot leave later prompts with a suspended deadline", async (t) => {
  const { agent } = await setup(t, { commandTimeoutMs: 70 });
  await agent.start();
  assert.deepEqual(await agent.prompt("input-response"), { disposition: "handled" });
  await assert.rejects(agent.prompt("hang"), /timed out: prompt/);
});

test("diagnostic deadlines remain active while input acceptance waits for a dialog", async (t) => {
  const { agent, events } = await setup(t, { args: [fixture, "--fake-mode", "diagnostic-hang"], commandTimeoutMs: 70 });
  await agent.start();
  const accepted = agent.prompt("input-confirm");
  const rejected = assert.rejects(accepted, /timed out: get_messages/);
  await waitFor(() => events.some((event) => event.method === "confirm"));
  await delay(200);
  await assert.rejects(agent.getMessages(), /timed out: get_messages/);
  await rejected;
});

test("abort clears queued work before abort; close is idempotent", async (t) => {
  const { agent, cwd } = await setup(t);
  await agent.start();
  await agent.prompt("first");
  await agent.steer("queued");
  await agent.abort();
  assert.equal(agent.settled, true);
  const commands = (await readFile(join(cwd, "commands.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(commands.slice(-2).map((command) => command.type), ["clear_queue", "abort"]);
  assert.strictEqual(agent.close(), agent.close());
  await agent.close();
  await assert.rejects(agent.prompt("closed"), /not ready/);
});

test("RPC command errors reject only that command", async (t) => {
  const { agent } = await setup(t);
  await agent.start();
  await assert.rejects(agent.prompt("reject"), /fixture rejection/);
  assert.equal((await agent.getState()).sessionId, "stable-session");
  await assert.rejects(agent.request("new_session"), /identity cannot change/);
});

for (const [mode, expression] of [
  ["startup-exit", /exited/], ["startup-hang", /timed out/],
  ["wrong-session", /identity/], ["no-report-extension", /did not initialize/],
] as const) {
  test(`startup failure is bounded: ${mode}`, async (t) => {
    const { agent } = await setup(t, { args: [fixture, "--fake-mode", mode], startupTimeoutMs: 150 });
    await assert.rejects(agent.start(), expression);
    await agent.close();
  });
}

test("missing executable rejects startup", async (t) => {
  const { agent } = await setup(t, { command: "/not/a/pi/executable", args: [] });
  await assert.rejects(agent.start(), /ENOENT/);
});

for (const [prompt, expression] of [
  ["exit", /exited/], ["hang", /timed out/], ["malformed", /Invalid Pi RPC output/],
  ["oversize", /byte limit/], ["mismatch", /Mismatched/],
] as const) {
  test(`protocol failure closes child and rejects in-flight requests: ${prompt}`, async (t) => {
    const { agent, events } = await setup(t, { commandTimeoutMs: 150, maxFrameBytes: 2048 });
    await agent.start();
    await assert.rejects(agent.prompt(prompt), expression);
    await agent.close();
    assert(events.some((event) => event.type === "driver_error"));
  });
}

test("stderr, pending requests and write queues are bounded", async (t) => {
  const { agent } = await setup(t, { maxPendingRequests: 1, maxQueuedWriteBytes: 2048 });
  await agent.start();
  const messages = agent.getMessages();
  await assert.rejects(agent.getState(), /Too many pending/);
  await messages;
  await agent.prompt("stderr");
  await delay(30);
  assert.equal(Buffer.byteLength(agent.stderr), 65536);
  await assert.rejects(agent.prompt("x".repeat(4096)), /write queue exceeds/);
});

test("stdin backpressure preserves complete command frames and response IDs", async (t) => {
  const { agent } = await setup(t, { args: [fixture, "--fake-mode", "slow-input"], commandTimeoutMs: 3000 });
  await agent.start();
  const results = await Promise.all(Array.from({ length: 12 }, (_value, index) =>
    agent.request("fixture_echo", { message: String(index).repeat(128_000) })));
  assert.deepEqual(results, Array.from({ length: 12 }, (_value, index) => ({ length: String(index).length * 128_000 })));
});

test("a throwing event subscriber closes the child instead of dropping journal events", async (t) => {
  const { agent } = await setup(t);
  await agent.start();
  agent.subscribe((event) => { if (event.type === "agent_start") throw new Error("journal failure"); });
  await assert.rejects(agent.prompt("work"), /listener failed/);
  await agent.close();
});

test("shutdown escalates for a child that ignores EOF and SIGTERM", async (t) => {
  const { agent, events } = await setup(t, { args: [fixture, "--fake-mode", "ignore-shutdown"] });
  await agent.start();
  const pid = agent.pid!;
  await agent.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert(events.some((event) => event.type === "process_exit" && event.signal === "SIGKILL"));
});

test("owned process group closes child descendants", async (t) => {
  const { agent, cwd } = await setup(t, { args: [fixture, "--fake-mode", "descendant"] });
  await agent.start();
  const grandchild = Number(await readFile(join(cwd, "grandchild.pid"), "utf8"));
  await agent.close();
  try {
    process.kill(grandchild, 0);
    // Container PID 1 may defer reaping an orphan. A zombie has stopped executing.
    assert.match(await readFile(`/proc/${grandchild}/stat`, "utf8"), /\) Z /);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
});

test("session-changing CLI flags and invalid limits are rejected before spawn", () => {
  const base = { cwd: ".", sessionId: "test", sessionDir: ".", role: "implementer" as const, reportPath: "report.json", phaseToken: "phase" };
  for (const arg of ["--continue", "--session=x", "--no-session", "--mode=json"]) {
    assert.throws(() => new PiAgent({ ...base, args: [arg] }), /Driver owns/);
  }
  assert.throws(() => new PiAgent({ ...base, sessionId: "../bad" }), /Invalid Pi session ID/);
  assert.throws(() => new PiAgent({ ...base, commandTimeoutMs: 0 }), /positive integers/);
});
