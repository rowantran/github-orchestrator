import { test as base, expect } from "@playwright/test";
import { fixture, SKELETON, REVISED } from "./fixture.mjs";
import { checkLargeGraphFit } from "../../dashboard/tests/fit-browser.js";

const test = base.extend({
  app: async ({ page }, use) => {
    const app = await fixture();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(app.server.url);
    await expect(page.locator("#task-42")).toBeVisible();
    await expect(page.locator("#runtime-status")).toContainText("Live execution");
    try { await use(app); } finally { await app.server.close(); }
    expect(errors).toEqual([]);
  },
});

async function select(page, number) {
  await page.locator("#task-search").fill(`#${number}`);
  await page.locator(`#task-${number}`).click();
  await expect(page.locator("#run-panel")).toBeVisible();
}

test("graph retains workstreams, dependency edges, external blockers, fit and literal task text", async ({ page, app }) => {
  await expect(page.locator('.dependency-edge[data-from="41"][data-to="42"]')).toHaveCount(1);
  await page.locator("#workstream-select").selectOption("api");
  await expect(page.locator(".task-node")).toHaveCount(3);
  await expect(page.locator(".dependency-edge")).toHaveCount(0);
  await select(page, 45);
  await expect(page.locator("#detail-panel")).toContainText("External dependency");
  await expect(page.locator("#start-task")).toBeDisabled();
  await page.locator("#task-search").fill("");
  await page.locator("#workstream-select").selectOption("empty");
  await expect(page.locator("#graph-state")).toContainText("This workstream is empty");
  await page.locator("#workstream-select").selectOption("");
  await select(page, 46);
  await expect(page.locator("#detail-title")).toHaveText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#detail-panel img")).toHaveCount(0);
  await page.locator("#close-detail").click();
  await page.locator("#task-search").fill("");
  await page.locator("#fit-graph").click();
  await expect(page.locator("#zoom-level")).not.toHaveText("0%");
  expect(app.snapshotCount()).toBe(1);
});

test("approve binds the displayed SHA, preserves implementation session, and supports pause/resume", async ({ page, app }) => {
  await select(page, 42);
  await expect(page.locator("#run-phase")).toHaveText("Awaiting approval");
  await expect(page.locator("#skeleton-sha")).toHaveText(SKELETON);
  await expect(page.locator("#agent-session")).toContainText("implementer-session-42");
  await page.locator("#approve-skeleton").click();
  await expect(page.locator("#run-phase")).toHaveText("Implementing");
  expect(app.calls).toContainEqual(["approve", 42, SKELETON]);
  await expect(page.locator("#agent-session")).toContainText("implementer-session-42");
  await expect(page.locator("#agent-status")).toContainText("implementation-model");
  await expect(page.locator("#run-summary")).toContainText(`Approved commit: ${SKELETON}`);
  await page.locator("#pause-task").click();
  await expect(page.locator("#run-phase")).toHaveText("Paused");
  await page.locator("#resume-task").click();
  await expect(page.locator("#run-phase")).toHaveText("Implementing");
  expect(app.calls).toContainEqual(["pause", 42]);
  expect(app.calls).toContainEqual(["resume", 42]);
  expect(app.snapshotCount()).toBe(1);
});

test("stale skeleton approval fails visibly and does not approve a new commit", async ({ page, app }) => {
  await select(page, 42);
  await expect(page.locator("#skeleton-sha")).toHaveText(SKELETON);
  // Change server state only when the old visible SHA is submitted, avoiding a polling race.
  await page.route("**/api/runs/42/approve", async route => {
    app.runs.get(42).skeletonSha = REVISED;
    await route.continue();
  });
  await page.locator("#approve-skeleton").click();
  await expect(page.locator("#run-action-result")).toContainText("Skeleton changed");
  expect(app.calls).toContainEqual(["approve", 42, SKELETON]);
  expect(app.runs.get(42).approvedSha).toBeUndefined();
  await expect(page.locator("#skeleton-sha")).toHaveText(REVISED);
});

test("start supervised and unsupervised tasks from the dashboard", async ({ page, app }) => {
  await select(page, 43);
  await expect(page.locator("#run-mode")).toHaveValue("supervised");
  await page.locator("#start-task").click();
  await expect(page.locator("#run-phase")).toHaveText("Planning");
  expect(app.calls).toContainEqual(["start", 43, { mode: "supervised" }]);
  await select(page, 44);
  await page.locator("#run-mode").selectOption("unsupervised");
  await page.locator("#start-task").click();
  await expect(page.locator("#run-phase")).toHaveText("Planning");
  expect(app.calls).toContainEqual(["start", 44, { mode: "unsupervised" }]);
  await expect(page.locator("#run-summary")).toContainText("Unsupervised");
});

test("chat shows Pi history, streaming output, tool results and role-specific nudges without TUI focus", async ({ page, app }) => {
  await select(page, 42);
  await expect(page.locator("#agent-transcript")).toContainText("The skeleton is committed");
  await page.locator(".tool-output summary").first().click();
  await expect(page.locator("#agent-transcript")).toContainText("12 tests passed");
  await expect(page.locator("#focus-pane-button")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("agent-chat.png"), fullPage: true });
  await page.locator("#agent-message").fill("Please cover the empty response.");
  await page.locator("#send-agent-message").click();
  await expect(page.locator("#agent-message")).toHaveValue("");
  await expect(page.locator("#agent-transcript")).toContainText("Please cover the empty response.");
  expect(app.calls).toContainEqual(["message", 42, "implementer", "Please cover the empty response."]);
  app.view(42, "implementer").events.push(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking the failure path live…" } },
    { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "npm test" } },
    { type: "tool_execution_update", toolCallId: "t2", toolName: "bash", partialResult: { content: [{ type: "text", text: "Streaming test output: 13 tests passed" }] } },
  );
  await expect(page.locator(".streaming-output")).toContainText("Checking the failure path live");
  await expect(page.locator(".live-tool")).toContainText("Streaming test output: 13 tests passed");
  await page.locator("#agent-message").fill("Preserve this draft");
  await page.locator("#agent-role").selectOption("reviewer");
  await expect(page.locator("#agent-transcript")).toContainText("Reviewer conversation is separate");
  await page.locator("#agent-message").fill("Check authorization.");
  await page.locator("#send-agent-message").click();
  await expect(page.locator("#agent-message")).toHaveValue("");
  expect(app.calls).toContainEqual(["message", 42, "reviewer", "Check authorization."]);
  await page.locator("#agent-role").selectOption("implementer");
  await expect(page.locator("#agent-message")).toHaveValue("Preserve this draft");
  expect(app.snapshotCount()).toBe(1);
});

test("dialogs accept confirmation, selection, input and cancellation; failed messages retain the draft", async ({ page, app }) => {
  app.view(42, "implementer").dialogs.push(
    { id: "confirm-1", method: "confirm", title: "Run the tests?", message: "This fixture never launches a process." },
    { id: "select-1", method: "select", title: "Choose a strategy", options: ["Small change", "Broad change"] },
    { id: "input-1", method: "input", title: "Add context", placeholder: "Context" },
    { id: "editor-1", method: "editor", title: "Edit proposal", prefill: "Old proposal" },
  );
  await select(page, 42);
  await page.locator('[data-dialog-id="confirm-1"]').getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator('[data-dialog-id="confirm-1"]')).toHaveCount(0);
  expect(app.calls).toContainEqual(["respond", 42, "implementer", { id: "confirm-1", confirmed: true }]);
  await page.getByLabel("Choose a strategy").selectOption("Small change");
  await page.locator('[data-dialog-id="select-1"]').getByRole("button", { name: "Send response" }).click();
  await expect(page.locator('[data-dialog-id="select-1"]')).toHaveCount(0);
  expect(app.calls).toContainEqual(["respond", 42, "implementer", { id: "select-1", value: "Small change" }]);
  await page.getByLabel("Add context").fill("Keep the public API stable.");
  await page.locator('[data-dialog-id="input-1"]').getByRole("button", { name: "Send response" }).click();
  await expect(page.locator('[data-dialog-id="input-1"]')).toHaveCount(0);
  await page.locator('[data-dialog-id="editor-1"]').getByRole("button", { name: "Cancel dialog" }).click();
  await expect(page.locator('[data-dialog-id="editor-1"]')).toHaveCount(0);
  expect(app.calls).toContainEqual(["respond", 42, "implementer", { id: "editor-1", cancelled: true }]);
  app.failMessage(true);
  await page.locator("#agent-message").fill("Retain this retry message");
  await page.locator("#send-agent-message").click();
  await expect(page.locator("#run-action-result")).toContainText("Agent is disconnected");
  await expect(page.locator("#agent-message")).toHaveValue("Retain this retry message");
});

test("local lifecycle polls do not refresh GitHub and failed manual refresh preserves the graph", async ({ page, app }) => {
  await select(page, 42);
  app.runs.get(42).phase = "reviewing";
  await expect(page.locator("#run-phase")).toHaveText("Reviewing");
  await expect(page.locator('[data-run-issue="42"]')).toHaveText("Reviewing");
  app.runs.get(42).phase = "ready_to_merge";
  await expect(page.locator("#run-phase")).toHaveText("Ready to merge");
  expect(app.snapshotCount()).toBe(1);
  expect(app.calls.filter(call => call[0] === "runs").length).toBeGreaterThan(2);
  app.failSnapshot(true);
  await page.locator("#refresh-button").click();
  await expect(page.locator("#error-banner")).toContainText("Showing the last successful snapshot");
  await expect(page.locator("#task-42")).toBeVisible();
  expect(app.snapshotCount()).toBe(2);
});

test("token reload errors and untrusted transcript text are safe", async ({ page, app }) => {
  app.view(42, "implementer").messages.push({ role: "assistant", content: [{ type: "text", text: '<script>alert("bad")</script><img src="https://evil.test/pixel">' }] });
  const foreign = [];
  page.on("request", request => { if (!request.url().startsWith(app.server.url)) foreign.push(request.url()); });
  await select(page, 42);
  await expect(page.locator("#agent-transcript")).toContainText('<script>alert("bad")</script>');
  await expect(page.locator("#agent-transcript script, #agent-transcript img")).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch("/api/runs", { headers: { "x-gho-token": "expired" } })).status);
  expect(status).toBe(403);
  expect(foreign).toEqual([]);
});

test("large graph fit remains usable on the actual TypeScript server", async ({ page, app }) => {
  await checkLargeGraphFit(page, app.server.url);
});
