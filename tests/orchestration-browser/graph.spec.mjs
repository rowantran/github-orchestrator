import { test, expect, XSS_TITLE, XSS_BODY, selectTask } from "./fixture.mjs";

const visibleIssues = page => page.locator(".task-node").evaluateAll(nodes => nodes.map(node => Number(node.dataset.issue)).sort((a, b) => a - b));
const edges = page => page.locator(".dependency-edge").evaluateAll(paths => paths.map(path => `${path.dataset.from}:${path.dataset.to}`).sort());

test("graph shows all six states, completed work, and only visible local dependency edges", async ({ page, app }) => {
  expect(await visibleIssues(page)).toEqual([41, 42, 43, 44, 45, 46, 47]);
  for (const [state, count] of Object.entries({ blocked: 1, ready: 2, in_progress: 1, ready_for_review: 1, done: 1, closed: 1 })) {
    await expect(page.locator(`[data-status-count="${state}"]`)).toHaveText(String(count));
    await expect(page.locator(`.task-node.status-${state}`)).toHaveCount(count);
  }
  expect(await edges(page)).toEqual(["41:42", "47:43"]);
  await expect(page.locator("#task-9")).toHaveCount(0);
  await expect(page.locator("#project-link")).toHaveAttribute("href", "https://github.com/users/test/projects/1");
  await expect(page.locator("#view-title")).toHaveText("All tasks");
  expect(app.snapshotCount()).toBe(1);
  await page.screenshot({ path: test.info().outputPath("task-graph.png"), fullPage: true });
});

test("workstreams overlap without slash inheritance; filters, deep links and history preserve readiness", async ({ page, app }) => {
  const groups = page.getByLabel("Workstream", { exact: true });
  await groups.selectOption("platform");
  expect(await visibleIssues(page)).toEqual([41, 42, 44, 46]);
  await groups.selectOption("api");
  expect(await visibleIssues(page)).toEqual([42, 43, 45]);
  expect(await edges(page)).toEqual([]);
  await expect(page.locator("#task-43")).toHaveClass(/status-ready/);
  await selectTask(page, 43);
  await expect(page.locator("#detail-panel")).toContainText("Outside this view");
  await expect(page.locator("#detail-panel")).toContainText("Stack on");
  await expect(page.locator("#start-task")).toBeEnabled();

  await page.goto(`${app.server.url}?group=platform%2Fapi`);
  await expect(groups).toHaveValue("platform/api");
  await expect(page.locator(".task-node")).toHaveCount(2);
  expect(await visibleIssues(page)).toEqual([43, 47]);
  expect(await edges(page)).toEqual(["47:43"]);
  await groups.selectOption("api");
  await page.goBack();
  await expect(groups).toHaveValue("platform/api");
  expect(await visibleIssues(page)).toEqual([43, 47]);
  await page.goForward();
  await expect(groups).toHaveValue("api");
  expect(await visibleIssues(page)).toEqual([42, 43, 45]);

  await page.getByRole("searchbox", { name: "Search tasks" }).fill("supervised");
  expect(await visibleIssues(page)).toEqual([43]);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("no-such-task");
  await expect(page.locator("#graph-state")).toContainText("No matching tasks");
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("");
  await groups.selectOption("empty");
  await expect(page.locator(".task-node")).toHaveCount(0);
  await expect(page.locator("#graph-state")).toContainText("This workstream is empty");
  await expect(page.locator("#fit-graph")).toBeDisabled();
  await groups.selectOption("");
  expect(await visibleIssues(page)).toEqual([41, 42, 43, 44, 45, 46, 47]);
  expect(app.snapshotCount()).toBe(2); // Only navigation reloads the snapshot.
});

test("external blockers remain in details and hostile issue text and URLs stay inert", async ({ page, app }) => {
  await selectTask(page, 45);
  const detail = page.locator("#detail-panel");
  await expect(detail).toContainText("External repository");
  await expect(detail.getByRole("link", { name: /other\/repo #9/ })).toHaveAttribute("href", "https://github.com/other/repo/issues/9");
  await expect(page.locator("#start-task")).toBeDisabled();
  await expect(page.locator('.dependency-edge[data-from="9"]')).toHaveCount(0);
  await selectTask(page, 46);
  await expect(page.locator("#detail-title")).toHaveText(XSS_TITLE);
  await expect(detail.locator(".issue-body")).toHaveText(XSS_BODY);
  await expect(detail.getByRole("link", { name: "Issue #46 ↗", exact: true })).toHaveCount(0);
  await expect(page.locator("#graph-nodes img, #detail-panel img, #detail-panel script, #detail-panel a[href^='javascript:']")).toHaveCount(0);
  expect(await page.evaluate(() => window.__ghoXss)).toBeUndefined();
  expect(app.snapshotCount()).toBe(1);
});

test("draft, review and merged PR links stay above long content and open safely without an opener", async ({ page, app, browserSafety }) => {
  const cases = [[42, "Draft"], [47, "Open"], [41, "Merged"]];
  for (const [issue, state] of cases) {
    const task = app.tasks.find(task => task.number === issue);
    task.body = "Long task instructions and acceptance criteria.\n".repeat(200);
    task.pull_requests = [{ url: `https://github.com/test/repo/pull/${issue + 100}`, state: state === "Merged" ? "MERGED" : "OPEN", draft: state === "Draft", head: `test/gh-${issue}`, base: "main" }];
  }
  await page.locator("#refresh-button").click();
  await expect(page.locator("#refresh-button")).toBeEnabled();
  for (const [issue, state] of cases) {
    await selectTask(page, issue);
    const url = `https://github.com/test/repo/pull/${issue + 100}`;
    const link = page.locator("#detail-panel").getByRole("link", { name: `PR #${issue + 100} ↗`, exact: true });
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toBeInViewport();
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator(".pr-state")).toHaveText(state);
    const opened = page.waitForEvent("popup");
    await link.click();
    const popup = await opened;
    await expect(popup).toHaveURL(url);
    await expect(popup).toHaveTitle("Intercepted GitHub link");
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
    await expect(page).toHaveURL(app.server.url);
  }
  expect(browserSafety.githubVisits).toEqual(cases.map(([issue]) => `https://github.com/test/repo/pull/${issue + 100}`));
});

test("100 tasks fit below 12% zoom and keyboard navigation reveals distant cards", async ({ page, app }) => {
  const template = app.tasks.find(task => task.number === 43);
  const numbers = Array.from({ length: 100 }, (_, index) => 1001 + index);
  app.tasks.splice(0, app.tasks.length, ...numbers.map(number => ({ ...template, number, title: `Independent task ${number}`, blockers: [], workstreams: [], stack_on: [] })));
  await page.locator("#refresh-button").click();
  await expect(page.locator(".task-node")).toHaveCount(100);
  await expect(page.locator(".dependency-edge")).toHaveCount(0);

  const outsideViewport = (selector = ".task-node") => page.evaluate(selector => {
    const viewport = document.getElementById("graph-viewport").getBoundingClientRect();
    return [...document.querySelectorAll(selector)].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width <= 0 || box.height <= 0 || box.left < viewport.left - 1 || box.top < viewport.top - 1 || box.right > viewport.right + 1 || box.bottom > viewport.bottom + 1;
    }).map(node => node.dataset.issue);
  }, selector);
  await page.getByRole("button", { name: "Fit graph", exact: true }).click();
  await expect.poll(() => outsideViewport(), { message: "Every card fits inside the graph viewport" }).toEqual([]);
  const scale = () => page.locator("#graph-stage").evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
  const fitted = await scale();
  expect(fitted).toBeGreaterThan(0);
  expect(fitted).toBeLessThan(0.12);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  expect(await scale()).toBeCloseTo(fitted, 6);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(await scale()).toBeCloseTo(fitted * 1.2, 6);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  expect(await scale()).toBeCloseTo(fitted, 6);

  await page.getByRole("region", { name: "Task dependency graph", exact: true }).focus();
  for (let step = 0; step < 20; step++) await page.keyboard.press("+");
  expect((await page.locator(`#task-${numbers[0]}`).boundingBox()).height).toBeGreaterThan(100);
  expect((await outsideViewport()).length).toBeGreaterThan(0);
  await page.keyboard.press("Tab");
  await expect(page.locator(`#task-${numbers[0]}`)).toBeFocused();
  await expect.poll(() => outsideViewport(`#task-${numbers[0]}`)).toEqual([]);
  for (let index = 1; index < numbers.length; index++) await page.keyboard.press("ArrowDown");
  const last = numbers.at(-1);
  await expect(page.locator(`#task-${last}`)).toBeFocused();
  await expect.poll(() => outsideViewport(`#task-${last}`)).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail-title")).toHaveText(`Independent task ${last}`);
  await page.keyboard.press("Escape");
  await expect(page.locator("#detail-panel")).toBeHidden();
  await expect(page.locator(`#task-${last}`)).toBeFocused();
  expect(app.snapshotCount()).toBe(2);
});
