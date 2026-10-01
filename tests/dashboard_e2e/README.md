# Dashboard browser integration tests

These tests run Chromium against the **real compiled `gho dashboard` server**, not a mock web server. Playwright checks the HTTP API, embedded frontend, GitHub adapter, workstream commands, git worktree discovery, and tmux focus commands together. It uses real private tmux panes when the environment permits Unix sockets, with an explicitly reported fixture fallback on a sandbox socket denial. Tailscale Serve tests use a strict fake CLI and a loopback reverse proxy; they never contact a real Tailscale daemon.

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
  npm_config_cache=/tmp/gho-dashboard-e2e-npm-cache \
  GHO_E2E_REQUIRE_REAL_TMUX=1 npx playwright test
```

The private library path above contains extracted Ubuntu packages `libgbm1`, `libwayland-server0`, and `libxcb-randr0`, which this sandbox lacks. It is only needed in this environment. To recreate it without installing system packages, download those packages with `apt-get download` in `/tmp/gho-dashboard-e2e-libs`, then extract each `.deb` with `dpkg-deb --extract PACKAGE.deb root`.

If rebuilding there, use `CARGO_HOME=/tmp/gho-cargo-home cargo build --locked`. Set `GHO_E2E_BINARY` to an absolute binary path to test another build; otherwise tests use `target/debug/gho` in this checkout. There is no fallback to a globally installed `gho`.

To run only the Tailscale Serve cases, add `tailscale.spec.js` to `npx playwright test`. No Tailscale installation, tailnet access, or DNS changes are needed. The nine existing `dashboard.spec.js` tests still use local mode and assert that it never invokes Tailscale.

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
- `gho dashboard --tailscale-serve --port PORT` prints a short-node HTTP URL. Chromium loads all six tasks and focuses the selected private tmux pane through the fake Serve proxy. The backend uses a separate nonzero loopback port.
- The proxy preserves Host and Origin. Foreign hosts, foreign origins, the wrong scheme or port, and missing/incorrect tokens are rejected without tmux selection. The exact full node name is accepted.
- SIGTERM and SIGINT each exit the dashboard successfully, stop its foreground Serve child, remove only its temporary mapping, and close both listeners. Unrelated persistent and foreground mappings remain in status, with their fixture configuration byte-for-byte unchanged.
- A second dashboard cannot claim an occupied Serve port. The original process, session, configuration, and browser access remain unchanged.

## Isolation and fixtures

Each test creates its own temporary git repository, worktree, `HOME`, and `GHO_CONFIG_DIR`. It removes inherited GitHub credentials, git configuration overrides, and tmux variables. Git has an inert GitHub origin only for repository identity; no fetch or push runs.

`fake-gh.py` is the first `gh` on the child process's `PATH`. It serves strict command-level REST/GraphQL fixture data from `state.json`, records calls, permits only local workstream label mutations, and fails unknown commands. All writes are to that temporary JSON file, never to GitHub. The Project-membership query must explicitly include archived items. The fixture accepts strict batches of at most 50 issue aliases for membership and task hydration, and rejects hydration of issues outside the Project.

`fake-tmux.py` normally guards the real tmux: it allows only pane enumeration and selection, then executes tmux with `-S <temporary-directory>/tmux.sock`. Test setup starts that private server with `-f /dev/null` and two tagged panes. Cleanup kills **only that socket's server**. It never enumerates, attaches to, selects panes in, or kills the user's tmux server.

If creating the private server fails specifically with `Operation not permitted`, this sandbox cannot provide real pane-selection coverage. The fixture reports that restriction in the test output and test annotations, then uses a file-backed pane simulation through the same subprocess/API paths. Unknown tmux commands still fail. Other startup errors fail the tests instead of triggering fallback. tmux is required, and no browser test is skipped. Set `GHO_E2E_REQUIRE_REAL_TMUX=1` in CI to forbid the sandbox fallback and require real private pane-selection coverage.

`fake-tailscale.py` is the first `tailscale` on `PATH` in **every** test, including local mode. It accepts only `status --json --peers=false`, `serve status --json`, and `serve --bg=false --http=PORT [--yes] http://127.0.0.1:BACKEND`. Unknown commands, persistent serving, Funnel, `off`, and `reset` fail and are logged. It never executes the real CLI. Its status reports a running node named `rowan-v2-dev.example.ts.net.` with MagicDNS enabled.

The fake Serve process binds only `127.0.0.1:PORT`, forwards only to the separate loopback backend, and preserves Host and Origin. `tailscale-session.json` records the PID, process identity, session ID, and exact proxy. Status reports the session under `Foreground` only while its owner is alive, so SIGKILL cleanup models a daemon dropping a disconnected foreground session. `tailscale-config.json` represents unrelated daemon settings and is never changed by the fake CLI. Shutdown tests add both persistent and other foreground mappings to that fixture file after startup, then verify that both survive cleanup of the dashboard's own session. An occupied configured or OS port is rejected before writing a session. The proxy records requests for assertions; failure artifacts include both state and call logs.

Chromium's test-only resolver rules map `rowan-v2-dev` and its full name to `127.0.0.1`, with system proxies disabled. This does not change host DNS or Tailscale settings. The browser may request only this test's exact app origin: either loopback in local mode or the mapped short node in Serve mode. Direct security probes explicitly connect to loopback while setting hostile HTTP headers. GitHub link navigations are fulfilled locally with a fixed page so link clicks cause no network request. Other external requests are blocked and fail the test. No GitHub credentials or real repository/Project access are needed. npm/browser installation is the only step that can require an external download.

## Files and results

- `fixture.js`: temporary app, git/config/tmux setup, browser network guard, and cleanup.
- `fake-gh.py`, `fake-tmux.py`, `fake-tailscale.py`: strict subprocess adapters; the Tailscale adapter also runs the loopback-only reverse proxy.
- `dashboard.spec.js`: existing local browser and command integration tests.
- `tailscale.spec.js`: isolated Serve graph/focus, security, shutdown, and occupied-port tests.
- `playwright.config.js`, `package.json`, `package-lock.json`: isolated test tooling; no frontend runtime dependency.

Screenshots are written to ignored `test-results/**/dashboard-root.png`, `dashboard-details.png`, `dashboard-100-tasks-fit.png`, and `dashboard-100-tasks-keyboard.png` on successful runs. Failed tests also retain a screenshot, trace, server output, and fake-command logs. Open a trace with `npx playwright show-trace test-results/<test-directory>/trace.zip`.

These tests complement, rather than replace, the Rust adapter/router tests and the frontend unit tests. Run the repository's other checks separately.
