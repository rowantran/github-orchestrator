import { mkdirSync, readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const mode = value("--fake-mode") || "normal";
const sessionId = value("--session-id");
const sessionDir = value("--session-dir");
const log = join(process.cwd(), "commands.jsonl");
if (mode === "startup-exit") { process.stderr.write("startup fixture failure\n"); process.exit(17); }
if (mode === "startup-hang") { process.stdin.resume(); setInterval(() => {}, 1000); }
else {
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  const previous = readFileSync(sessionFile, "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line));
  const messages = previous.map((entry) => entry.message).filter(Boolean);
  const state = {
    sessionId: mode === "wrong-session" ? "wrong-session" : sessionId,
    sessionFile, model: { provider: "fixture", id: "first", name: "First" }, thinkingLevel: "medium",
    isStreaming: false, isCompacting: false, pendingMessageCount: 0,
  };
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const reply = (command, data) => emit({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) });
  let buffer = "";
  let grandchild;
  let bootstrapCommand;
  let bootstrapAnswered = mode !== "bootstrap-dialog";
  const inputCommands = new Map();
  if (mode === "descendant") {
    grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    writeFileSync(join(process.cwd(), "grandchild.pid"), String(grandchild.pid));
  }
  if (mode === "ignore-shutdown") process.on("SIGTERM", () => {});
  if (mode === "descendant") process.on("SIGTERM", () => {});
  const reportReady = () => emit({
    type: "extension_ui_request", id: "ready", method: "setStatus", statusKey: "gho:report",
    statusText: JSON.stringify({ phaseToken: process.env.GHO_PHASE_TOKEN, reportPath: process.env.GHO_REPORT_PATH }),
  });
  if (mode === "bootstrap-dialog") emit({ type: "extension_ui_request", id: "bootstrap", method: "confirm", title: "fixture" });
  else if (mode !== "no-report-extension") reportReady();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const command = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      appendFileSync(log, `${JSON.stringify(command)}\n`);
      if (["prompt", "steer"].includes(command.type) && command.message.startsWith("input-")) {
        const id = `input-${command.id}`;
        const entry = { command, timer: undefined };
        inputCommands.set(id, entry);
        const timeout = command.message.startsWith("input-timeout") ? 180 : undefined;
        emit({ type: "extension_ui_request", id, method: "confirm", title: "fixture", ...(timeout ? { timeout } : {}) });
        if (timeout) entry.timer = setTimeout(() => {
          inputCommands.delete(id);
          if (command.message !== "input-timeout-hang") reply(command, { disposition: "handled" });
        }, timeout);
        if (command.message === "input-start-hang") setTimeout(() => emit({ type: "agent_start" }), 180);
        if (command.message === "input-response") setTimeout(() => {
          inputCommands.delete(id);
          reply(command, { disposition: "handled" });
        }, 180);
        continue;
      }
      if (mode === "diagnostic-hang" && inputCommands.size && command.type === "get_messages") continue;
      if (command.type === "get_state") {
        if (!bootstrapAnswered) { bootstrapCommand = command; continue; }
        reply(command, state);
        if (mode === "slow-input") {
          process.stdin.pause();
          setTimeout(() => process.stdin.resume(), 100);
        }
      }
      else if (command.type === "get_messages") setTimeout(() => reply(command, { messages }), 20);
      else if (command.type === "get_available_models") reply(command, { models: [state.model, { provider: "fixture", id: "second/nested", name: "Second" }, { provider: "local", id: "model:7b" }] });
      else if (command.type === "set_model") {
        state.model = { provider: command.provider, id: command.modelId };
        reply(command, state.model);
      } else if (command.type === "get_available_thinking_levels") reply(command, { levels: ["off", "medium", "high"] });
      else if (command.type === "set_thinking_level") {
        if (mode !== "ignore-thinking") state.thinkingLevel = command.level;
        reply(command);
      } else if (command.type === "prompt") {
        if (command.message === "reject") { emit({ id: command.id, type: "response", command: "prompt", success: false, error: "fixture rejection" }); continue; }
        if (command.message === "exit") process.exit(23);
        if (command.message === "hang") continue;
        if (command.message === "malformed") { process.stdout.write("not-json\n"); continue; }
        if (command.message === "oversize") { process.stdout.write("x".repeat(4096)); continue; }
        if (command.message === "mismatch") { emit({ id: command.id, type: "response", command: "get_messages", success: true }); continue; }
        if (command.message === "stderr") { process.stderr.write("x".repeat(100_000)); reply(command, { disposition: "handled" }); continue; }
        if (command.message === "handled") { reply(command, { disposition: "handled" }); continue; }
        if (command.message === "dialog") {
          emit({ type: "extension_ui_request", id: "approval", method: "confirm", title: "fixture" });
          reply(command, { disposition: "handled" });
          continue;
        }
        if (command.message === "unicode") {
          const text = `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a\u2028b\u2029c😀" } })}\r\n`;
          const bytes = Buffer.from(text);
          // Split in the middle of a UTF-8 character as well as across record boundaries.
          const position = bytes.indexOf(Buffer.from("😀")) + 2;
          process.stdout.write(bytes.subarray(0, position));
          process.stdout.write(bytes.subarray(position));
          reply(command, { disposition: "handled" });
          continue;
        }
        const message = { role: "user", content: command.message };
        messages.push(message);
        appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message })}\n`);
        state.isStreaming = true;
        emit({ type: "agent_start" });
        reply(command, { disposition: "started" });
        emit({ type: "agent_end", messages: [], willRetry: true });
      } else if (command.type === "steer") {
        state.pendingMessageCount++;
        reply(command, { disposition: "queued" });
      } else if (command.type === "clear_queue") {
        state.pendingMessageCount = 0;
        reply(command, { steering: [], followUp: [] });
      } else if (command.type === "abort") {
        state.isStreaming = false;
        emit({ type: "agent_settled" });
        reply(command);
      } else if (command.type === "extension_ui_response") {
        emit({ type: "fixture_dialog_answer", answer: command });
        if (command.id === "bootstrap") {
          bootstrapAnswered = true;
          reportReady();
          if (bootstrapCommand) reply(bootstrapCommand, state);
        }
        const input = inputCommands.get(command.id);
        if (input) {
          clearTimeout(input.timer);
          inputCommands.delete(command.id);
          if (input.command.message !== "input-answer-hang") reply(input.command, { disposition: "handled" });
        }
      }
      else if (command.type === "fixture_settle") {
        state.isStreaming = false;
        state.pendingMessageCount = 0;
        emit({ type: "agent_settled" });
        reply(command);
      } else if (command.type === "fixture_echo") reply(command, { length: command.message.length });
      else if (command.type === "fixture_inspect") reply(command, { args, phaseToken: process.env.GHO_PHASE_TOKEN, reportPath: process.env.GHO_REPORT_PATH, role: process.env.GHO_AGENT_ROLE });
      else reply(command);
    }
  });
  process.stdin.on("end", () => {
    if (mode === "ignore-shutdown") { setInterval(() => {}, 1000); return; }
    if (grandchild) {
      // Neither process exits voluntarily: only the driver's process-group signals stop them.
      setInterval(() => {}, 1000);
    } else process.exit(0);
  });
}
