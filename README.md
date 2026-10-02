# GitHub Orchestrator

`gho` turns GitHub issues into persistent Pi work sessions. Talk to a supervisor agent, which operates the CLI; an independent orchestration service handles scheduling, worktrees, agents, reviews, and the dashboard.

```text
You ↔ supervisor agent → gho CLI → orchestration service
                                       ├─ GitHub tasks and dependency graph
                                       ├─ Worktrunk worktrees
                                       ├─ Pi planner/implementer + reviewer
                                       └─ dashboard ↔ you
```

Closing the supervisor's session does not stop enrolled tasks. The service never merges a PR.

## Install and configure

Requirements: Linux or macOS, Node.js 24+, Git, an authenticated GitHub CLI (`gh` 2.94+ for native issue dependencies), Worktrunk (`wt`), and a configured Pi installation (`~/.pi/agent`). The Pi CLI on `PATH` is needed only for `agents.runtime = "rpc"`. The service also needs `flock` for OS-held locks (included in Linux util-linux; on macOS: `brew install flock`).

```sh
npm ci
npm link                         # installs this checkout's TypeScript gho CLI
pi install /absolute/path/to/github-orchestrator

gh auth refresh -s project
cd /path/to/your/repository
gho init
gho doctor
```

`gho init` creates missing configuration files without overwriting existing files. Fill in your Project URL before using other commands. `gho doctor` checks prerequisites and compares the CLI's build commit with the published `main` commit. An unknown, different, or unavailable version produces a warning, not a failure.

`~/.config/github-orchestrator/config.toml`:

```toml
owner = "your-github-login"

[agents]
# "durable" (default): workers run on Pi Durable inside the service.
# "rpc": each worker is a full `pi --mode rpc` process with all of your Pi extensions.
runtime = "durable"
# Optional normal Pi model patterns. Omit to use Pi's settings/saved session model.
planner_model = "provider/planning-model"
implementer_model = "provider/implementation-model"
reviewer_model = "provider/review-model"

[orchestration]
max_concurrency = 3
poll_interval_ms = 15000
agent_timeout_ms = 3600000
max_attempts = 3
max_review_rounds = 3

[obsidian]
# vault = "/path/to/vault"
```

`~/.config/github-orchestrator/repos/OWNER/REPO.toml`:

```toml
project_url = "https://github.com/users/your-github-login/projects/123"
base_branch = "main"
```

Repository settings can override the `[orchestration]` values. The checkout's `origin` selects the repository. `--config-dir PATH` or `GHO_CONFIG_DIR` selects a different configuration directory. Unknown keys fail validation. Restart the service after changing its configuration.

**Migration:** `gho` is now the npm-installed TypeScript CLI; the Rust implementation has been removed. Existing TOML configuration, branches, workstreams, and TaskNotes associations remain usable. If you previously installed the Cargo binary, check `command -v gho` after linking and adjust `PATH` or uninstall the old Cargo package so the npm executable is selected. Existing manually managed worktrees are not silently adopted into agent execution. The old tmux pane controls and `--gho-agent` status extension are replaced by the service-owned sessions, dashboard chat, and `gho agent` commands.

## Plan, register, and enroll work

The installed `github-orchestrator` skill teaches your supervisor agent to use these commands:

```sh
gho task create --title "One bounded change" --body-file task.md --blocked-by 41
gho ready --json
gho ready --all --json

gho run 42 --mode supervised
gho run 43 44 --mode unsupervised
gho status
gho status 42
```

Each issue should contain its goal, scope, acceptance criteria, and verification commands. `run` enrolls explicit tasks; it does not start arbitrary issues from your Project. Blocked tasks wait until their dependencies are ready. Repeating enrollment with the same mode is idempotent; changing a running task's mode is rejected.

Both workflows commit a pseudocode/stub skeleton at the real implementation paths and open a draft PR:

| Phase | Supervised | Unsupervised |
| --- | --- | --- |
| Plan | Commit and push skeleton; open draft PR | Same |
| Approval | Wait for explicit approval of the full skeleton SHA | Record automatic workflow approval |
| Implement | Continue the same Pi session; optionally change model | Same |
| Review | Separate reviewer; findings return to implementer within a bounded fix loop | Same |
| Publish | Service marks PR ready after review and CI pass | Same |
| Merge | Human decision | Human decision |

Planner and implementer are the **same saved conversation**, even when their model or process changes. A reviewer has its own conversation. Only one agent writes a task's worktree at a time. An idle approval gate consumes no agent slot. Checks that are pending prevent publication; a repository with no CI checks relies on the worker's and reviewer's recorded verification.

The default review/CI fix limit is three rounds. Failed or interrupted agent attempts have bounded retries and backoff. A question or exhausted retry budget blocks the task and is visible in the dashboard. `resume` explicitly retries after you resolve it.

## Approve, inspect, and nudge

```sh
gho dashboard
gho dashboard --tailscale-serve --port 8080
gho approve 42 --sha FULL_SKELETON_COMMIT_SHA

gho agent show 42 --role implementer
gho agent message 42 "Reconsider the error handling" --role implementer
gho agent message 42 --file feedback.md --role reviewer
gho pause 42
gho resume 42
```

The dashboard keeps the dependency graph and workstream filters. Select a task to start it, inspect its lifecycle, choose an agent, read messages and tool activity, send a message, answer supported Pi extension dialogs, or approve the displayed skeleton revision. Local agent polling does not refresh GitHub's entire graph.

Approval is available through the dashboard, CLI, or a GitHub PR conversation comment/submitted review containing exactly:

```text
/gho approve FULL_SKELETON_COMMIT_SHA
```

GitHub approval commands must come from the configured `owner`. A changed revision requires a new approval. GitHub feedback is delivered as phase input; agent comments beginning with `[agent:]` are ignored. Pending review comments are not delivered until submitted.

A nudge is **not approval**. Nudging a planner at the approval gate starts skeleton revision, not implementation. Messages to paused/blocked work are retained but do not resume it. A supervisor may run `approve` when you explicitly ask it to approve that revision. The workflow never interprets “looks good” as permission.

### Worker runtimes

**Durable (default).** Each task role is a [Pi Durable](https://earendil.com/posts/pi-durable/) conversation hosted by the service. Workers inherit from your normal Pi configuration:

- credentials (`auth.json`), `models.json`, and providers that installed Pi extensions register (for example a company LLM proxy);
- the default provider, model, and thinking level, plus compaction, retry, steering, follow-up, shell, and HTTP proxy/timeout settings;
- global and project `AGENTS.md`/context files, skills (including skills from Pi packages), `SYSTEM.md`, and `APPEND_SYSTEM.md`, rendered by Pi's own system prompt builder.

Workers get `read`, `bash`, `edit`, `write`, and `gho_report`. Pi extension tools, hooks, commands, MCP servers, and dialogs do **not** run in durable workers; Pi extensions load only so their providers register. Extensions that choose a model at session start (for example a machine-local model override) have no effect; set `agents.*_model` instead. `gho doctor` loads your Pi configuration like the service and shows which model each role resolves to, without contacting a model. Durable workers depend on the exact pinned Pi version because Pi does not export its system prompt builder.

**RPC.** Set `runtime = "rpc"` to launch the actual `pi --mode rpc` executable per role. It loads every Pi extension, tool, and MCP server and supports standard extension dialogs, answered explicitly in the dashboard; terminal-specific custom UI is not supported. Tested with Pi 0.99.2. In that version, an extension that awaits a dialog inside `session_start` can block before Pi installs its RPC input reader; defer that dialog to an input/tool hook or give it a finite timeout. The service reports startup failure rather than automatically approving it.

The service adds its own instructions and a structured `gho_report` tool in both runtimes. Changing the runtime of a task that already has a conversation starts a new conversation for that role; the recovery prompt tells it to inspect existing work first.

## Service lifecycle and recovery

```sh
gho service start               # independent background service
gho service status
gho service stop                # saves state and stops owned agents
gho serve                       # foreground alternative
```

`run` and `dashboard` start the service if needed. One service owns a repository's Git common directory, including its worktrees. Each worker also holds an OS lock for its worktree, so a replacement cannot overlap a delayed old worker. Configure it under a process manager if it must restart automatically after machine/process failure.

GitHub remains the task store. Private execution checkpoints, event journals, the service descriptor, and logs live in `<git-common-dir>/gho-service/`. Worker conversations (`.gho/sessions/<session>.sqlite` for durable workers, Pi JSONL sessions for RPC workers) and phase reports live in each worktree's ignored `.gho/`. There is no local task database. Preserve these files to preserve approvals and conversation identity; they may contain sensitive task and agent output.

A restart reuses the same task/role session IDs, preserves approval gates, and checks persisted phase reports before resuming an interrupted turn. A durable worker continues its interrupted turn by itself: a cut-off model request is sent again, an interrupted `bash`/`edit`/`write` call is reported to the model as interrupted rather than rerun, and queued nudges are delivered into that turn. Pausing or stopping the service keeps such a turn for later; a run that exceeds its deadline is aborted first. An RPC worker instead receives a recovery prompt. This is task/session recovery, not exactly-once execution of arbitrary shell commands. Recovery instructions require inspecting existing Git/GitHub effects before repeating actions. Do not concurrently open a service-owned session in another Pi process; inspect and message it through the dashboard/CLI instead.

## Task dependencies and workstreams

`ready` lists open issues assigned to the configured owner in the configured Project. Task states remain:

- `done`: issue closed as completed.
- `closed`: not planned or duplicate; never unblocks dependents.
- `ready_for_review`: an open, non-draft PR from `<owner>/gh-N`.
- `in_progress`: a draft PR or existing local branch.
- `ready`: no branch, and every blocker is done or ready for review.
- `blocked`: everything else.

Blockers under review must form one PR chain. New work starts from its top, or the latest configured base branch when no stack is needed. PRs are found by branch because closing keywords do not link stacked PRs reliably. A merged PR finishes its local execution, but dependents and TaskNotes still use the GitHub issue's completion state. Close a delivered stacked issue as completed when GitHub cannot apply its closing keyword. `gho worktree N --base REF` remains an explicit manual readiness override; service enrollment does not use it.

```sh
gho workstream create project-a
gho workstream create project-a/feature-1
gho workstream add project-a 41 42
gho workstream remove project-a 42
gho workstream list --json
gho task create --title "Change" --body-file task.md --workstream project-a
```

Memberships are overlapping GitHub labels, `gho:workstream:NAME`. Slash-separated names do not inherit membership. The graph includes completed, closed, archived, and other-assignee Project issues. Filtering never changes readiness; external blockers remain visible in task details.

## Local and tailnet access

The server binds only to `127.0.0.1`. API requests require its private session token, exact Host/Origin checks, and same-origin browser access. The browser never receives GitHub credentials. Use an SSH tunnel for remote access or explicit `--tailscale-serve`.

Tailscale sharing uses only an owned temporary foreground Serve process, refuses occupied Serve/Funnel ports, keeps the backend on a separate loopback port, and leaves unrelated mappings alone. It never enables Funnel, uses sudo, or changes tailnet policy. Tailnet access rules are the authorization boundary: anyone allowed to reach the dashboard can read agent output, send messages, approve skeletons, and control tasks. Restrict those rules. Do not expose it through a public proxy.

These controls protect the service interface, not arbitrary agent tool execution. Workers run with the permissions and credentials of normal Pi; use your normal sandbox and trust only the repositories/tasks you enroll.

## Optional TaskNotes bridge

```sh
(cd obsidian-plugin && npm ci && npm test && npm run build)
gho notes install --yes           # enable the plugin in Obsidian yourself
gho notes link "Tasks/example.md" 42 43
gho notes list
gho notes complete
```

Only issues closed as completed count toward note completion. See [obsidian-plugin/README.md](obsidian-plugin/README.md).

## Development and verification

```sh
npm ci
npm test                         # core, engine, RPC, Pi Durable, HTTP, CLI, and Pi integration tests
npm run test:browser              # Playwright CLI: real HTTP server and browser flows
(cd dashboard && npm test && npm run build)
(cd obsidian-plugin && npm ci && npm test && npm run build)
```

Browser setup: `npx playwright install --with-deps chromium`. Tests use temporary repositories/vaults, fake GitHub/Pi subprocesses, and isolated service state. The installed-Pi smoke test exercises real RPC resource discovery without a model request or real credentials. Durable worker tests use Pi's faux provider and a local OpenAI-compatible fake server. No test creates real issues/PRs or changes a real vault.

[docs/architecture.md](docs/architecture.md) describes implementation ownership. [tests/orchestration-browser/README.md](tests/orchestration-browser/README.md) describes the Playwright CLI suite for the TypeScript service and dashboard.
