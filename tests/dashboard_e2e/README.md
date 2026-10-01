# Dashboard browser integration tests

These tests run Chromium against the **real compiled `gho dashboard` server**, not a mock web server. Playwright checks the HTTP API, embedded frontend, GitHub adapter, workstream commands, git worktree discovery, and tmux focus commands together. It uses real private tmux panes when the environment permits Unix sockets, with an explicitly reported fixture fallback on a sandbox socket denial.

## Run

Requirements: Node.js 20+, npm, Python 3, git, tmux, Rust, and Playwright Chromium with its OS libraries. On Linux, `npx playwright install-deps chromium` installs the system libraries when you have system package permissions.

From the repository root, build the binary **after frontend or Rust changes**. Dashboard assets are compiled into the binary:

```sh
cargo build --locked
cd tests/dashboard_e2e
npm ci --ignore-scripts
npx playwright install chromium  # only when the browser is not already cached
npx playwright test
```

Or run `tests/dashboard_e2e/run.sh` after building. The script installs the locked test dependencies and runs `npx playwright test`. Pass Playwright options through it, for example `tests/dashboard_e2e/run.sh --grep 'focus selects'`.

For the supplied agent environment, the browser is already installed. Its default npm cache is read-only, so use:

```sh
cd tests/dashboard_e2e
npm ci --ignore-scripts --cache /tmp/gho-dashboard-e2e-npm-cache
LD_LIBRARY_PATH=/tmp/gho-dashboard-e2e-libs/root/usr/lib/x86_64-linux-gnu \
  PLAYWRIGHT_BROWSERS_PATH=/home/ubuntu/.cache/ms-playwright \
  npm_config_cache=/tmp/gho-dashboard-e2e-npm-cache npx playwright test
```

The private library path above contains extracted Ubuntu packages `libgbm1`, `libwayland-server0`, and `libxcb-randr0`, which this sandbox lacks. It is only needed in this environment. To recreate it without installing system packages, download those packages with `apt-get download` in `/tmp/gho-dashboard-e2e-libs`, then extract each `.deb` with `dpkg-deb --extract PACKAGE.deb root`.

If rebuilding there, use `CARGO_HOME=/tmp/gho-cargo-home cargo build --locked`. Set `GHO_E2E_BINARY` to an absolute binary path to test another build; otherwise tests use `target/debug/gho` in this checkout. There is no fallback to a globally installed `gho`.

## Coverage

- The root graph includes all six states: blocked, ready, in progress, ready for review, completed, and closed without completion. An unassigned completed task is included, but an issue outside the configured Project is not.
- `project-a`, `project-a/feature-1`, and `project-b` overlap through explicit memberships. Slash-separated names do not imply a parent group. Empty groups remain selectable. Filtering changes visible edges, not task classification.
- A 100-task independent graph loads through the real snapshot API. **Fit graph** puts every card fully inside the viewport. After zooming back in, Tab and arrow keys reveal the first and last cards, and Enter opens the last task's details.
- External blockers appear in task details but not as local graph nodes or edges.
- Draft, open, and merged branch-associated pull requests have the correct clickable URLs. A click opens a separate page with no `window.opener`.
- Selecting a pane calls the real API and changes the active pane on an isolated tmux server (or explicit file-backed fallback). Changed pane ownership is rejected without selecting a pane.
- Missing or incorrect tokens, foreign origins, invalid pane IDs, invisible issues, and mismatched task/pane pairs cannot focus a pane.
- A fake GitHub process failure produces a real HTTP 502. The UI retains its last graph and selected details, reports the failure, and recovers on the next refresh.
- HTML/script payloads in issue titles and bodies remain text. Every test checks for uncaught page errors and unexpected browser requests.
- Real `gho workstream create/list/add/remove` commands preserve unrelated labels and memberships, are idempotent where expected, encode slash labels correctly, and reject invalid or cross-repository changes before writes.

## Isolation and fixtures

Each test creates its own temporary git repository, worktree, `HOME`, and `GHO_CONFIG_DIR`. It removes inherited GitHub credentials, git configuration overrides, and tmux variables. Git has an inert GitHub origin only for repository identity; no fetch or push runs.

`fake-gh.py` is the first `gh` on the child process's `PATH`. It serves strict command-level REST/GraphQL fixture data from `state.json`, records calls, permits only local workstream label mutations, and fails unknown commands. All writes are to that temporary JSON file, never to GitHub. The Project-membership query must explicitly include archived items. The fixture accepts strict batches of at most 50 issue aliases for membership and task hydration, and rejects hydration of issues outside the Project.

`fake-tmux.py` normally guards the real tmux: it allows only pane enumeration and selection, then executes tmux with `-S <temporary-directory>/tmux.sock`. Test setup starts that private server with `-f /dev/null` and two tagged panes. Cleanup kills **only that socket's server**. It never enumerates, attaches to, selects panes in, or kills the user's tmux server.

If creating the private server fails specifically with `Operation not permitted`, this sandbox cannot provide real pane-selection coverage. The fixture reports that restriction in the test output and test annotations, then uses a file-backed pane simulation through the same subprocess/API paths. Unknown tmux commands still fail. Other startup errors fail the tests instead of triggering fallback. tmux is required, and no browser test is skipped. Set `GHO_E2E_REQUIRE_REAL_TMUX=1` in CI to forbid the sandbox fallback and require real private pane-selection coverage.

The browser can request only this test's loopback origin. GitHub link navigations are fulfilled locally with a fixed page so link clicks cause no network request. Other external requests are blocked and fail the test. No GitHub credentials or real repository/Project access are needed. npm/browser installation is the only step that can require an external download.

## Files and results

- `fixture.js`: temporary app, git/config/tmux setup, browser network guard, and cleanup.
- `fake-gh.py`, `fake-tmux.py`: strict subprocess adapters.
- `dashboard.spec.js`: browser and command integration tests.
- `playwright.config.js`, `package.json`, `package-lock.json`: isolated test tooling; no frontend runtime dependency.

Screenshots are written to ignored `test-results/**/dashboard-root.png`, `dashboard-details.png`, `dashboard-100-tasks-fit.png`, and `dashboard-100-tasks-keyboard.png` on successful runs. Failed tests also retain a screenshot, trace, server output, and fake-command logs. Open a trace with `npx playwright show-trace test-results/<test-directory>/trace.zip`.

These tests complement, rather than replace, the Rust adapter/router tests and the frontend unit tests. Run the repository's other checks separately.
