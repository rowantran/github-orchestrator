// Tests for the agent status extension with a fake Pi API, in temporary directories.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import agentStatus, { HEARTBEAT_MS, LAST_MESSAGE_CHARS, STARTUP_GRACE_MS, lastAssistantText, statusPath } from "../agent-status.mjs";

let cwd;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "gho-agent-status-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function fakePi(flag) {
	const handlers = new Map();
	const flags = new Map();
	return {
		handlers,
		registerFlag: (name, options) => flags.set(name, options),
		getFlag: (name) => (flags.has(name) ? flag : undefined),
		on: (event, handler) => handlers.set(event, handler),
		emit: (event, payload, ctx) => handlers.get(event)?.({ type: event, ...payload }, ctx),
	};
}

function fakeContext({ idle = false, entries = [], notices = [] } = {}) {
	return {
		cwd,
		isIdle: () => idle,
		ui: { notify: (message, level) => notices.push({ message, level }) },
		sessionManager: { getSessionFile: () => "/sessions/one.jsonl", getBranch: () => entries },
	};
}

function fakeClock() {
	let now = Date.parse("2026-01-01T00:00:00.000Z");
	return { now: () => new Date(now), advance: (ms) => (now += ms) };
}

const read = (name = "implementer") => JSON.parse(readFileSync(statusPath(cwd, name), "utf8"));

test("is inert without the flag", () => {
	const pi = fakePi(undefined);
	agentStatus(pi);
	pi.emit("session_start", { reason: "startup" }, fakeContext());
	pi.emit("agent_start", {}, fakeContext());
	assert.equal(existsSync(join(cwd, ".gho")), false);
});

test("records each state change with when it began", () => {
	const pi = fakePi("implementer");
	const clock = fakeClock();
	agentStatus(pi, clock);
	pi.emit("session_start", { reason: "startup" }, fakeContext());
	assert.equal(read().state, "starting");
	assert.equal(readFileSync(join(cwd, ".gho/.gitignore"), "utf8"), "*\n");

	clock.advance(1000);
	pi.emit("agent_start", {}, fakeContext());
	const working = read();
	assert.equal(working.state, "working");
	assert.equal(working.since, "2026-01-01T00:00:01.000Z");

	clock.advance(1000);
	pi.emit("ui_prompt_start", { kind: "confirm" }, fakeContext());
	assert.equal(read().state, "prompting");
	pi.emit("ui_prompt_end", {}, fakeContext());
	assert.equal(read().state, "working");

	clock.advance(1000);
	const entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Opened the draft PR." }] } },
		{ type: "message", message: { role: "toolResult", content: [] } },
	];
	pi.emit("agent_settled", {}, fakeContext({ entries }));
	const settled = read();
	assert.equal(settled.state, "settled");
	assert.equal(settled.since, "2026-01-01T00:00:03.000Z");
	assert.equal(settled.last_message, "Opened the draft PR.");
	assert.equal(settled.session_file, "/sessions/one.jsonl");
	assert.equal(settled.agent, "implementer");

	clock.advance(1000);
	pi.emit("agent_start", {}, fakeContext());
	assert.equal(read().last_message, null);

	pi.emit("session_shutdown", { reason: "quit" }, fakeContext());
	assert.equal(read().state, "exited");
});

test("a resumed or new session starts from the agent's actual activity", () => {
	const pi = fakePi("reviewer");
	agentStatus(pi, fakeClock());
	pi.emit("session_start", { reason: "new" }, fakeContext({ idle: true }));
	assert.equal(read("reviewer").state, "settled");
	pi.emit("session_shutdown", { reason: "new" }, fakeContext());
	assert.equal(read("reviewer").state, "settled");
});

test("heartbeats, and settles a session that started without a prompt", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pi = fakePi("implementer");
	const clock = fakeClock();
	agentStatus(pi, clock);
	pi.emit("session_start", { reason: "startup" }, fakeContext({ idle: true }));
	clock.advance(HEARTBEAT_MS);
	t.mock.timers.tick(HEARTBEAT_MS);
	assert.equal(read().state, "starting");
	assert.equal(read().updated_at, "2026-01-01T00:00:05.000Z");
	clock.advance(STARTUP_GRACE_MS);
	t.mock.timers.tick(HEARTBEAT_MS);
	assert.equal(read().state, "settled");
	pi.emit("session_shutdown", { reason: "quit" }, fakeContext());
	const exited = read().updated_at;
	clock.advance(HEARTBEAT_MS);
	t.mock.timers.tick(HEARTBEAT_MS);
	assert.equal(read().updated_at, exited);
});

test("rejects names that cannot be file names", () => {
	const notices = [];
	const pi = fakePi("../x");
	agentStatus(pi);
	pi.emit("session_start", { reason: "startup" }, fakeContext({ notices }));
	assert.equal(notices[0].level, "error");
	assert.equal(existsSync(join(cwd, ".gho")), false);
});

test("keeps the end of a long last message", () => {
	const text = `${"a".repeat(LAST_MESSAGE_CHARS)}END`;
	const result = lastAssistantText([{ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }]);
	assert.equal(result.length, LAST_MESSAGE_CHARS + 1);
	assert.ok(result.startsWith("…") && result.endsWith("END"));
	assert.equal(lastAssistantText([]), null);
});
