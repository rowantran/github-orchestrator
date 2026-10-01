import { test, expect, PREFIX, XSS_TITLE, XSS_BODY } from "./fixture.js";

const nodes = (page) => page.locator("#graph-nodes [data-issue]");
const task = (page, number) => page.locator(`#graph-nodes [data-issue="${number}"]`);
const detail = (page) => page.getByRole("complementary", { name: "Task details", exact: true });
async function visibleIssues(page) {
  return nodes(page).evaluateAll((elements) => elements.map((element) => Number(element.dataset.issue)).sort((a, b) => a - b));
}
async function selectTask(page, number) {
  // Focus first so keyboard navigation reveals nodes outside the panned viewport.
  await task(page, number).focus();
  await task(page, number).press("Enter");
  await expect(detail(page)).toBeVisible();
}

test("root shows all six states, completed work, and only local dependency edges", async ({ page, app }, testInfo) => {
  const snapshotRequest = page.waitForRequest((request) => request.url() === `${app.url}api/snapshot`);
  const snapshot = await app.open(page);
  expect(snapshot.repo).toBe("acme/app");
  expect(snapshot.tasks.map(({ number, state }) => [number, state])).toEqual([
    [1, "blocked"], [2, "ready"], [3, "in_progress"], [4, "ready_for_review"], [5, "done"], [6, "closed"],
  ]);
  expect(snapshot.tasks.find((item) => item.number === 2).stack_on).toEqual([4]);
  const token = await page.locator('meta[name="gho-token"]').getAttribute("content");
  expect(token).toBeTruthy();
  expect(token).not.toBe("__GHO_TOKEN__");
  expect((await (await snapshotRequest).allHeaders())["x-gho-token"]).toBe(token);
  await expect(nodes(page)).toHaveCount(6);
  expect(await visibleIssues(page)).toEqual([1, 2, 3, 4, 5, 6]);
  for (const state of ["blocked", "ready", "in_progress", "ready_for_review", "done", "closed"]) {
    await expect(page.locator(`[data-status-count="${state}"]`)).toHaveText("1");
    await expect(page.locator(`#graph-nodes .status-${state}.task-node`)).toHaveCount(1);
  }
  const edges = await page.locator(".dependency-edge").evaluateAll((items) => items.map((item) => `${item.dataset.from}:${item.dataset.to}`).sort());
  expect(edges).toEqual(["4:1", "4:2", "5:2"]);
  await expect(task(page, 7)).toHaveCount(0);
  await expect(task(page, 99)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "All tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open project" })).toHaveAttribute("href", "https://github.com/orgs/acme/projects/7");
  await page.screenshot({ path: testInfo.outputPath("dashboard-root.png"), fullPage: true });
});

test("Fit graph contains 100 independent tasks and keyboard navigation reveals distant cards", async ({ page, app }, testInfo) => {
  test.setTimeout(120_000); // The real backend allows up to 90 seconds for one snapshot.
  const state = app.state();
  const template = state.issues["acme/app#2"];
  const numbers = Array.from({ length: 100 }, (_, index) => 1001 + index);
  state.issues = Object.fromEntries(numbers.map((number) => [`acme/app#${number}`, {
    ...template, number, title: `Independent task ${number}`, body: `Scale fixture ${number}`,
    blockers: [], labels: [], closing_prs: [],
  }]));
  state.branch_prs = {};
  app.replaceState(state);
  const snapshot = await app.open(page);
  expect(snapshot.tasks).toHaveLength(100);
  expect(snapshot.tasks.every((item) => item.state === "ready" && item.blockers.length === 0)).toBe(true);
  await expect(nodes(page)).toHaveCount(100);
  await expect(page.locator(".dependency-edge")).toHaveCount(0);

  const viewport = page.getByRole("region", { name: "Task dependency graph", exact: true });
  const outsideViewport = (selector = "#graph-nodes [data-issue]") => page.evaluate((selector) => {
    const viewport = document.getElementById("graph-viewport").getBoundingClientRect();
    return [...document.querySelectorAll(selector)].flatMap((node) => {
      const box = node.getBoundingClientRect();
      const inside = box.width > 0 && box.height > 0 && box.left >= viewport.left - 1 && box.top >= viewport.top - 1
        && box.right <= viewport.right + 1 && box.bottom <= viewport.bottom + 1;
      return inside ? [] : [{ issue: node.dataset.issue, box: box.toJSON(), viewport: viewport.toJSON() }];
    });
  }, selector);

  await page.getByRole("button", { name: "Fit graph", exact: true }).click();
  await expect.poll(() => outsideViewport(), { message: "Every card must fit completely inside the graph viewport" }).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("dashboard-100-tasks-fit.png"), fullPage: true });
  const scale = () => page.locator("#graph-stage").evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
  const fitted = await scale();
  expect(fitted).toBeGreaterThan(0);
  expect(fitted).toBeLessThan(0.12); // The previous minimum could not contain this graph.
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  expect(await scale()).toBeCloseTo(fitted, 6);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(await scale()).toBeCloseTo(fitted * 1.2, 6);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  expect(await scale()).toBeCloseTo(fitted, 6);

  // Restore a readable scale, then use only Tab/arrow keys to reach the first
  // and last cards. The focus handler must pan the graph to reveal each card.
  await viewport.focus();
  for (let step = 0; step < 20; step++) await page.keyboard.press("+");
  expect((await task(page, numbers[0]).boundingBox()).height).toBeGreaterThan(100);
  expect((await outsideViewport()).length).toBeGreaterThan(0);
  await page.keyboard.press("Tab");
  await expect(task(page, numbers[0])).toBeFocused();
  await expect.poll(() => outsideViewport(`#task-${numbers[0]}`)).toEqual([]);
  for (let index = 1; index < numbers.length; index++) await page.keyboard.press("ArrowDown");
  const last = numbers.at(-1);
  await expect(task(page, last)).toBeFocused();
  await expect.poll(() => outsideViewport(`#task-${last}`)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("dashboard-100-tasks-keyboard.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await expect(detail(page).getByRole("heading", { name: `Independent task ${last}`, exact: true })).toBeVisible();
});

test("workstreams overlap but slash names do not imply membership; empty groups remain selectable", async ({ page, app }) => {
  await app.open(page);
  const groups = page.getByLabel("Workstream", { exact: true });
  await groups.selectOption("project-a");
  expect(await visibleIssues(page)).toEqual([1, 3, 4]);
  await expect(task(page, 2)).toHaveCount(0);
  await expect(task(page, 1)).toHaveClass(/status-blocked/);
  await groups.selectOption("project-a/feature-1");
  expect(await visibleIssues(page)).toEqual([2, 3, 5]);
  await expect(task(page, 2)).toHaveClass(/status-ready/);
  expect(await page.locator(".dependency-edge").evaluateAll((items) => items.map((item) => `${item.dataset.from}:${item.dataset.to}`))).toEqual(["5:2"]);
  // The hidden review blocker still determines readiness, and appears in details.
  await selectTask(page, 2);
  await expect(detail(page)).toContainText("Outside this view");
  await expect(detail(page)).toContainText("Stack on");
  await groups.selectOption("project-b");
  expect(await visibleIssues(page)).toEqual([1, 3, 4, 6]);
  await groups.selectOption("project-empty");
  await expect(nodes(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "This workstream is empty" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fit graph" })).toBeDisabled();
  await app.open(page, "?group=project-a%2Ffeature-1");
  expect(await visibleIssues(page)).toEqual([2, 3, 5]);
  await groups.selectOption("");
  expect(await visibleIssues(page)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("external blockers stay in details and hostile issue text never becomes HTML", async ({ page, app }, testInfo) => {
  await app.open(page);
  await selectTask(page, 1);
  await expect(detail(page).getByRole("heading", { name: XSS_TITLE, exact: true })).toBeVisible();
  await expect(detail(page).locator(".issue-body")).toHaveText(XSS_BODY);
  await expect(detail(page).getByRole("link", { name: /outside\/repo #99/ })).toHaveAttribute("href", "https://github.com/outside/repo/issues/99");
  await expect(detail(page)).toContainText("External repository");
  await expect(detail(page).getByRole("button", { name: "Focus task pane" })).toBeDisabled();
  await expect(task(page, 99)).toHaveCount(0);
  await expect(page.locator(".dependency-edge[data-from='99']")).toHaveCount(0);
  await expect(page.locator("#graph-nodes img, #detail-panel img, #detail-panel script, #detail-panel a[href^='javascript:']")).toHaveCount(0);
  expect(await page.evaluate(() => window.__ghoXss)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath("dashboard-details.png"), fullPage: true });
});

test("draft, review, and merged PR links open their exact GitHub URL without an opener", async ({ page, app, browserSafety }) => {
  const state = app.state();
  for (const issue of [3, 4, 5]) state.issues[`acme/app#${issue}`].body = "Long task instructions and acceptance criteria.\n".repeat(200);
  app.replaceState(state);
  await app.open(page);
  for (const [issue, state] of [[3, "Draft"], [4, "Open"], [5, "Merged"]]) {
    await selectTask(page, issue);
    const url = `https://github.com/acme/app/pull/${100 + issue}`;
    const link = detail(page).getByRole("link", { name: `PR #${100 + issue} ↗`, exact: true });
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toBeInViewport(); // Primary actions must not sit below a long issue description.
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute("rel", /noreferrer/);
    await expect(detail(page).locator(".pr-state")).toHaveText(state);
    const opened = page.waitForEvent("popup");
    await link.click();
    const popup = await opened;
    await expect(popup).toHaveURL(url);
    await expect(popup).toHaveTitle("Intercepted GitHub link");
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
    await expect(page).toHaveURL(app.url);
  }
  expect(browserSafety.githubVisits).toEqual([103, 104, 105].map((number) => `https://github.com/acme/app/pull/${number}`));
});

test("focus selects the requested pane and rejects stale ownership", async ({ page, app }) => {
  const snapshot = await app.open(page);
  expect(snapshot.tasks.find((item) => item.number === 3).panes.map(({ id }) => id).sort()).toEqual([app.firstPane, app.secondPane].sort());
  expect(app.activePane()).toBe(app.firstPane);
  await selectTask(page, 3);
  await page.getByLabel("Choose a pane").selectOption(app.secondPane);
  const focused = page.waitForResponse((response) => response.url() === `${app.url}api/focus`);
  await page.getByRole("button", { name: "Focus task pane" }).click();
  const response = await focused;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ issue: 3, pane: app.secondPane });
  expect((await response.request().allHeaders())["x-gho-token"]).toBe(await page.locator('meta[name="gho-token"]').getAttribute("content"));
  await expect(page.locator("#focus-result")).toHaveText("Agent pane selected in tmux.");
  expect(app.activePane()).toBe(app.secondPane);
  const selections = () => app.calls("tmux").filter((args) => args[1].startsWith("select-"));
  expect(selections().at(-1)).toEqual(["-N", "select-pane", "-t", app.secondPane]);
  const before = selections().length;
  app.retagPane(app.firstPane, 99);
  await page.getByLabel("Choose a pane").selectOption(app.firstPane);
  const stale = page.waitForResponse((response) => response.url() === `${app.url}api/focus`);
  await page.getByRole("button", { name: "Focus task pane" }).click();
  expect((await stale).status()).toBe(409);
  await expect(page.locator("#focus-result")).toContainText("Could not focus pane");
  expect(selections()).toHaveLength(before);
  expect(app.activePane()).toBe(app.secondPane);
});

test("a real backend refresh failure preserves the graph and selected details, then recovers", async ({ page, app }) => {
  await app.open(page);
  await selectTask(page, 3);
  app.failRefresh();
  const failed = page.waitForResponse((response) => response.url() === `${app.url}api/snapshot`);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await failed).status()).toBe(502);
  await expect(page.getByRole("alert")).toContainText("Fixture GitHub unavailable");
  await expect(page.getByRole("alert")).toContainText("Showing the last successful snapshot");
  expect(await visibleIssues(page)).toEqual([1, 2, 3, 4, 5, 6]);
  await expect(detail(page).getByRole("heading", { name: "Draft implementation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  app.recoverRefresh();
  const recovered = page.waitForResponse((response) => response.url() === `${app.url}api/snapshot`);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await recovered).status()).toBe(200);
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(detail(page).getByRole("heading", { name: "Draft implementation", exact: true })).toBeVisible();
});

test("HTTP token, origin, and pane validation prevent unauthorized focus", async ({ page, app }) => {
  await app.open(page);
  const token = await page.locator('meta[name="gho-token"]').getAttribute("content");
  const endpoint = `${app.url}api/focus`;
  const data = { issue: 3, pane: app.secondPane };
  expect((await page.request.get(`${app.url}api/snapshot`)).status()).toBe(403);
  expect((await page.request.post(endpoint, { data })).status()).toBe(403);
  expect((await page.request.post(endpoint, { headers: { "X-GHO-Token": "wrong" }, data })).status()).toBe(403);
  expect((await page.request.post(endpoint, { headers: { "X-GHO-Token": token, Origin: "https://attacker.invalid" }, data })).status()).toBe(403);
  const headers = { "X-GHO-Token": token };
  expect((await page.request.post(endpoint, { headers, data: { issue: 3, pane: "%0; kill-server" } })).status()).toBe(400);
  expect((await page.request.post(endpoint, { headers, data: { issue: 999, pane: app.secondPane } })).status()).toBe(409);
  expect((await page.request.post(endpoint, { headers, data: { issue: 2, pane: app.secondPane } })).status()).toBe(409);
  expect(app.calls("tmux").filter((args) => args[1].startsWith("select-"))).toEqual([]);
  expect(app.activePane()).toBe(app.firstPane);
});

test("real workstream CLI mutations preserve unrelated labels and overlapping memberships", async ({ app }) => {
  expect(JSON.parse(app.cli("workstream", "list", "--json"))).toEqual(["project-a", "project-a/feature-1", "project-b", "project-empty"]);
  app.cli("workstream", "create", "project-c/new");
  app.cli("workstream", "create", "project-c/new");
  app.cli("workstream", "add", "project-c/new", "2", "3", "3");
  app.cli("workstream", "remove", "project-a/feature-1", "3");
  const state = app.state();
  expect(state.issues["acme/app#3"].labels.sort()).toEqual(["bug", PREFIX + "project-a", PREFIX + "project-b", PREFIX + "project-c/new"].sort());
  expect(state.issues["acme/app#2"].labels.sort()).toEqual(["bug", PREFIX + "project-a/feature-1", PREFIX + "project-c/new"].sort());
  const writes = () => app.calls().filter((args) => args.includes("--method"));
  expect(writes().filter((args) => args[3] === "repos/acme/app/labels")).toHaveLength(1);
  expect(writes()).toHaveLength(4); // One create, two additive writes, one exact membership removal.
  expect(writes().at(-1)[3]).toMatch(/\/labels\/%67%68%6F%3A/);
  const before = writes().length;
  expect(() => app.cli("workstream", "create", "project-a//invalid")).toThrow(/Invalid workstream name/);
  expect(() => app.cli("workstream", "add", "project-a", "https://github.com/outside/repo/issues/99")).toThrow(/cannot change/);
  expect(writes()).toHaveLength(before);
});
