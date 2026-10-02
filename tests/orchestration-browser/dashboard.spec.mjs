import { test, expect, SKELETON, REVISED, selectTask as select } from "./fixture.mjs";

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
  const starting = page.waitForRequest(request => request.url() === `${app.server.url}api/runs/43/start`);
  await page.locator("#start-task").click();
  const request = await starting;
  expect(request.postDataJSON()).toEqual({ mode: "supervised" });
  const headers = await request.allHeaders();
  expect(headers["x-gho-token"]).toBe(await page.locator('meta[name="gho-token"]').getAttribute("content"));
  expect(headers.origin).toBe(new URL(app.server.url).origin);
  await expect(page.locator("#run-phase")).toHaveText("Planning");
  expect(app.calls).toContainEqual(["start", 43, { mode: "supervised" }]);
  await select(page, 44);
  await page.locator("#run-mode").selectOption("unsupervised");
  await page.locator("#start-task").click();
  await expect(page.locator("#run-phase")).toHaveText("Planning");
  expect(app.calls).toContainEqual(["start", 44, { mode: "unsupervised" }]);
  await expect(page.locator("#run-summary")).toContainText("Unsupervised");
});

test("chat shows Pi history, streaming output, tool results and role-specific nudges", async ({ page, app }) => {
  await select(page, 42);
  await expect(page.locator("#agent-transcript")).toContainText("The skeleton is committed");
  await page.locator(".tool-output summary").first().click();
  await expect(page.locator("#agent-transcript")).toContainText("12 tests passed");
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
  await expect(page.locator("#detail-title")).toHaveText("Build the task API");
  await expect(page.locator("#run-phase")).toHaveText("Ready to merge");
  await expect(page.locator("#refresh-button")).toBeEnabled();
  expect(app.snapshotCount()).toBe(2);
  app.failSnapshot(false);
  app.tasks.find(task => task.number === 42).title = "Updated task API";
  await page.locator("#refresh-button").click();
  await expect(page.locator("#error-banner")).toBeHidden();
  await expect(page.locator("#detail-title")).toHaveText("Updated task API");
  await expect(page.locator("#run-phase")).toHaveText("Ready to merge");
  expect(app.snapshotCount()).toBe(3);
});

test("token reload errors and untrusted transcript text are safe", async ({ page, app }) => {
  app.view(42, "implementer").messages.push({ role: "assistant", content: [{ type: "text", text: '<script>alert("bad")</script><img src="https://evil.test/pixel">' }] });
  await select(page, 42);
  await expect(page.locator("#agent-transcript")).toContainText('<script>alert("bad")</script>');
  await expect(page.locator("#agent-transcript script, #agent-transcript img")).toHaveCount(0);
  // Alter the request, not the response: the real server rejects the expired token.
  await page.route("**/api/runs", route => route.continue({ headers: { ...route.request().headers(), "x-gho-token": "expired" } }));
  await expect(page.locator("#runtime-status")).toContainText("Reload the dashboard page");
  await expect(page.locator("#agent-transcript")).toContainText("The skeleton is committed");
  await page.unroute("**/api/runs");
  await expect(page.locator("#runtime-status")).toContainText("Live execution");
});
