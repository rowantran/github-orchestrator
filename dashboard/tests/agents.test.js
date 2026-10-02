import assert from "node:assert/strict";
import { test } from "node:test";
import { PHASES, piContent, liveAgentOutput } from "../app.js";

test("all lifecycle phases have visible labels", () => {
  for (const phase of ["queued", "planning", "awaiting_approval", "implementing", "reviewing", "ready_to_merge", "paused", "blocked", "done", "closed"]) assert.equal(typeof PHASES[phase], "string");
});
test("Pi content renders text, thinking, tool arguments and image placeholders without markup parsing", () => {
  assert.equal(piContent("plain"), "plain");
  assert.equal(piContent([{ type: "text", text: "<script>alert(1)</script>" }, { type: "thinking", thinking: "Check a boundary" }]), "<script>alert(1)</script>\nCheck a boundary");
  assert.match(piContent({ type: "toolCall", name: "bash", arguments: { command: "npm test" } }), /npm test/);
  assert.match(piContent({ type: "image", data: "private-image-data" }), /Image omitted/);
  assert.doesNotMatch(piContent({ type: "image", data: "private-image-data" }), /private-image-data/);
  assert.equal(piContent(null), "");
});
test("raw Pi RPC deltas and tool updates stay visible until messages settle", () => {
  const events = [
    { type: "message_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working " } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "now" } },
    { type: "tool_execution_start", toolCallId: "id", toolName: "bash", args: { command: "echo output" } },
    { type: "tool_execution_update", toolCallId: "id", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } },
  ];
  assert.equal(liveAgentOutput(events).assistant, "Working now");
  assert.deepEqual(liveAgentOutput(events).tools, [{ name: "bash", output: "partial", running: true }]);
  events.push({ type: "tool_execution_end", toolCallId: "id", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false }, { type: "message_end" });
  assert.equal(liveAgentOutput(events).assistant, "");
  assert.equal(liveAgentOutput(events).tools[0].output, "done");
  assert.equal(liveAgentOutput(events).tools[0].running, false);
});
test("full partial message updates replace deltas instead of duplicating text", () => {
  const result = liveAgentOutput([
    { event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "whole partial" }] } } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " ignored", partial: { content: [{ type: "text", text: "new whole partial" }] } } },
  ]);
  assert.equal(result.assistant, "new whole partial");
});
