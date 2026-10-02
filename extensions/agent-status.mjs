// Purpose: record what a gho agent is doing, so `gho wait agents` can tell when it settles.
// Audience: Pi; loaded as an extension of this Pi package. Not model-facing: it registers a CLI flag, no tools.
// Injection: active only in Pi sessions started with --gho-agent=NAME; inert otherwise.
//
// The status file is <cwd>/.gho/agents/NAME.json. It is replaced atomically on each change and on a
// heartbeat, so a reader never sees a partial file and can tell a live agent from one that died.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FLAG = "gho-agent";
export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** How often a live agent rewrites its status. `gho wait agents` treats a status older than 60s as lost. */
export const HEARTBEAT_MS = 5_000;
/** A session that starts without a prompt counts as settled after this long. */
export const STARTUP_GRACE_MS = 10_000;
/** The end of the last assistant message is kept, where agents put their summary or question. */
export const LAST_MESSAGE_CHARS = 1_500;

export function statusPath(cwd, name) {
	return join(cwd, ".gho", "agents", `${name}.json`);
}

/** Write `status` to `path` with a rename, so readers see the old file or the new one. */
export function writeStatus(path, status) {
	const gho = join(path, "..", "..");
	if (!existsSync(gho)) {
		mkdirSync(gho, { recursive: true });
		writeFileSync(join(gho, ".gitignore"), "*\n");
	}
	mkdirSync(join(path, ".."), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
	renameSync(temporary, path);
}

/** The text of the last assistant message on the session branch, truncated to its end; null if none. */
export function lastAssistantText(entries) {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		const text = (Array.isArray(content) ? content : [])
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text === "") continue;
		return text.length > LAST_MESSAGE_CHARS ? `…${text.slice(-LAST_MESSAGE_CHARS)}` : text;
	}
	return null;
}

export default function agentStatus(pi, clock = { now: () => new Date() }) {
	pi.registerFlag(FLAG, {
		description: "Record this agent's activity in .gho/agents/NAME.json, for gho wait agents",
		type: "string",
	});

	/** The active session's status, or undefined when the flag is not set. */
	let active;

	function write(changes) {
		const now = clock.now().toISOString();
		const previous = active.status;
		const status = { ...previous, ...changes, updated_at: now };
		if (status.state !== previous.state) status.since = now;
		active.status = status;
		try {
			writeStatus(active.path, status);
		} catch (error) {
			active.ctx.ui.notify(`gho: cannot write ${active.path}: ${error.message}`, "error");
		}
	}

	function stop() {
		if (active?.timer) clearInterval(active.timer);
		if (active) active.timer = undefined;
	}

	pi.on("session_start", (event, ctx) => {
		stop();
		active = undefined;
		const name = pi.getFlag(FLAG);
		if (typeof name !== "string" || name === "") return;
		if (!NAME.test(name)) {
			ctx.ui.notify(`gho: --${FLAG} must be lowercase letters, digits and dashes, not ${JSON.stringify(name)}`, "error");
			return;
		}
		const now = clock.now().toISOString();
		// At startup the initial prompt has not run yet; anything else starts from an idle or running agent.
		const state = event.reason === "startup" ? "starting" : ctx.isIdle() ? "settled" : "working";
		active = {
			ctx,
			path: statusPath(ctx.cwd, name),
			status: {
				version: 1,
				agent: name,
				state,
				since: now,
				updated_at: now,
				pid: process.pid,
				session_file: ctx.sessionManager.getSessionFile() ?? null,
				last_message: null,
			},
		};
		write({});
		active.timer = setInterval(() => {
			const { status } = active;
			const waited = clock.now().getTime() - Date.parse(status.since);
			if (status.state === "starting" && waited >= STARTUP_GRACE_MS && active.ctx.isIdle()) {
				write({ state: "settled" });
			} else {
				write({});
			}
		}, HEARTBEAT_MS);
		active.timer.unref?.();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!active) return;
		active.ctx = ctx;
		write({ state: "working", last_message: null });
	});

	pi.on("ui_prompt_start", () => {
		if (active) write({ state: "prompting" });
	});

	pi.on("ui_prompt_end", () => {
		if (active?.status.state === "prompting") write({ state: "working" });
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!active) return;
		write({
			state: "settled",
			session_file: ctx.sessionManager.getSessionFile() ?? null,
			last_message: lastAssistantText(ctx.sessionManager.getBranch()),
		});
	});

	pi.on("session_shutdown", (event) => {
		if (!active) return;
		stop();
		// Other reasons replace the session in this process; the next session_start rewrites the status.
		if (event.reason === "quit") write({ state: "exited" });
	});
}
