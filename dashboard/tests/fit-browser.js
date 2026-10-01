import assert from "node:assert/strict";

/** Shared browser regression. Call from the integrated Playwright suite with a
 * fresh page and its local dashboard URL; all GitHub data is synthetic. */
export async function checkLargeGraphFit(page, url) {
  const snapshot = {
    repo: "test/large-graph",
    project_url: "https://github.com/users/test/projects/1",
    workstreams: [],
    tasks: Array.from({ length: 100 }, (_, i) => ({
      number: i + 1, title: `Independent task ${i + 1}`, state: "ready",
      url: `https://github.com/test/large-graph/issues/${i + 1}`,
      body: "", branch: null, worktree: null, workstreams: [], blockers: [], pull_requests: [], panes: [],
    })),
  };
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.goto(url);
  await page.locator("#task-100").waitFor({ state: "attached" });
  // Let the initial, readability-limited view finish before asking for true Fit.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.locator("#fit-graph").click();
  const bounds = await page.evaluate(() => {
    const viewport = document.querySelector("#graph-viewport").getBoundingClientRect();
    return {
      viewport: { left: viewport.left, top: viewport.top, right: viewport.right, bottom: viewport.bottom },
      nodes: [...document.querySelectorAll(".task-node")].map((node) => {
        const box = node.getBoundingClientRect();
        return { issue: node.dataset.issue, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      }),
    };
  });
  assert.equal(bounds.nodes.length, 100);
  for (const node of bounds.nodes) {
    assert.ok(node.left >= bounds.viewport.left - 0.5 && node.right <= bounds.viewport.right + 0.5, `Task ${node.issue} fits horizontally`);
    assert.ok(node.top >= bounds.viewport.top - 0.5 && node.bottom <= bounds.viewport.bottom + 0.5, `Task ${node.issue} fits vertically`);
  }
  const scale = () => page.locator("#graph-stage").evaluate((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
  const fitted = await scale();
  assert.ok(fitted > 0 && fitted < 0.12, "A tall graph fits below the old 12% zoom floor");
  await page.locator("#zoom-out").click();
  assert.ok(await scale() <= fitted + 1e-6, "Zoom-out from Fit must not zoom in");
  await page.locator("#zoom-in").click();
  assert.ok(Math.abs(await scale() - fitted * 1.2) < 1e-6, "Zoom-in takes one smooth step from Fit");
  await page.locator("#zoom-out").click();
  assert.ok(Math.abs(await scale() - fitted) < 1e-6, "Zoom-out returns to the fitted scale");
}
