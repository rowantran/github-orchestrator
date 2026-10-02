<!-- Purpose: explain responsibilities and module layout. Audience: maintainers. Injection: documentation only; not loaded into agents. -->
# Architecture

`gho` gives an orchestrator agent a few deterministic operations. Everything that needs judgment stays with the agent and the user.

```text
You ↔ orchestrator agent (Pi + the github-orchestrator skill)
        │ gho task create      → GitHub issue + Project + blocked-by links
        │ gho ready --json     → reads GitHub queue, open PRs by branch, local branches
        │ gho worktree N       → git fetch + wt switch --create + .gho/brief.md
        │ gho config           → agent models from the config
        │ gho workstream …     → overlapping issue memberships, stored as GitHub labels
        │ gho dashboard        → local graph + PR links + selection of existing tmux panes
        │ gho wait agents      → blocks until an agent settles (reads .gho/agents/*.json)
        ▼
   implementer agents, one per worktree, each in a tmux window
   (skeleton → draft PR → agreed with you in PR comments → implementation → PR published)
        │ gho wait review      → blocks until a review is submitted on the agent's PR
        │ Pi extension         → writes .gho/agents/NAME.json when started with --gho-agent=NAME
        ▼
   reviewer agent per PR → orchestrator relays findings → you review and merge
```

## Who owns what

| Owner | Responsibility |
| --- | --- |
| GitHub | Tasks: title, body, assignee, Project membership, blockers, open/closed and close reason. Workstream definitions and many-to-many memberships are repository labels. |
| Git checkout | Work in progress: branch `<owner>/gh-N` and its worktree. With an open draft PR, the issue is still in progress; once the PR is published (not a draft), it is ready for review. |
| `gho` | Reads the two above to classify issues; creates issues and worktrees; manages workstream labels and serves a read-only task graph. Can select an existing tmux pane, never launch or control its agent. Waits, read-only, for agent statuses and pull request reviews. No local database. |
| Pi extension | Records each launched agent's activity in its worktree's `.gho/agents/NAME.json`. |
| Orchestrator agent | Which tasks to start, launching and managing implementers, retries, stacking, review, publishing. |
| You | Plan approval, what to run, when to publish, merging. |

## Modules

| Module | Responsibility |
| --- | --- |
| `src/cli.rs` | Commands, argument parsing (clap), output. `src/main.rs` only calls it. |
| `src/config.rs`, `src/templates/` | The two config files and the branch naming rule: `config.toml` (owner, optional `[agents]` and `[obsidian]`) and `repos/OWNER/REPO.toml` (`project_url`, `base_branch`). Unknown keys are rejected. `gho init` writes the templates with inferred values. |
| `src/domain.rs` | Value types: `IssueRef`, `Issue`, `PullRequest`, and the state enums. |
| `src/github.rs` | Looks up the Project ID from the configured Project URL once per run. GitHub reads (queue, issues, blockers, labels, and PRs), issue creation, and workstream label mutations, through `gh`. Responses are decoded into strict types, so missing or partial API data is an error instead of looking like an empty queue. |
| `src/work.rs` | `survey()` (the queue) and `classify()` (one issue): the `State` of each issue and its blockers: `blocked`, `ready { stack_on }`, `in_progress`, `ready_for_review`, `done` or `closed`. The `Issues` and `Branches` traits let tests replace GitHub and git. |
| `src/workstreams.rs` | Workstream label validation and dashboard snapshots. Reads all repository/Project issues, including closed work and archived Project items, with all memberships and PR links. Membership comes directly from `ProjectV2.items(archivedStates: [ARCHIVED, NOT_ARCHIVED])`, not repository history. Task details, labels, and branch PRs are batched; overflowing connections retain strict pagination. Classification happens before display filtering. |
| `src/dashboard.rs`, `dashboard/` | Loopback-only HTTP server and embedded static graph UI. The browser filters overlapping groups, renders internal dependency edges, and shows external blockers in task details. API requests require a per-process token; Host/Origin checks and a content security policy protect local data and pane selection. Bounded connection workers parse requests and serve assets independently of GitHub reads. Request size/deadline limits and a 90-second snapshot subprocess budget prevent indefinite waits. |
| `src/tailscale.rs` | Optional tailnet HTTP sharing. Detects validated node names, refuses occupied Serve/Funnel ports, and owns a temporary foreground Tailscale Serve process targeting the loopback backend. Confirms startup and releases only its own foreground session on shutdown. |
| `src/tmux.rs` | Discover existing live panes, associate them by repository/issue tags (or one exact worktree path), and revalidate before selecting a window/pane. Missing tmux is an optional-integration warning. |
| `tests/dashboard_e2e/` | Playwright browser tests against the actual CLI in a temporary repository with fake GitHub responses. No real issues, PRs, or vaults. |
| `src/workspace.rs` | Git and Worktrunk: find the checkout and its GitHub repository from the working directory, fetch the base, list worktrees, create the issue's worktree, find the branch its pull request targets. |
| `src/brief.rs` | The task brief: fills in `agent-context/brief.md` (compiled in) and writes it to `.gho/brief.md` in the new worktree, next to a `.gitignore` that ignores `.gho/`. |
| `src/wait.rs` | The polling loop of `gho wait`: interval, timeout, and retries of failed checks after a first success. |
| `src/agents.rs`, `extensions/agent-status.mjs` | `gho wait agents`. The Pi extension writes one status file per agent (`starting`, `working`, `prompting`, `settled`, `exited`) with a 5-second heartbeat, replaced atomically. The Rust side reads them from issue worktrees, marks a status older than 60 seconds `lost`, and decides when the wait ends. The cursor maps each agent to the settling it last reported. |
| `src/reviews.rs` | `gho wait review`. Reads a pull request, its reviews and its review comments over REST, ignores pending, dismissed and agent-written reviews, and returns new submitted reviews with their comments. The cursor is the last handled submission time with the IDs handled at that second. |
| `src/version.rs`, `build.rs` | The version check of `gho doctor`. `build.rs` records the commit that `gho` is built from (`cargo install --git` builds in a Git checkout); `gho doctor` compares it with the tip of `main` in the repository from `Cargo.toml`, read with `git ls-remote`. Every commit is a new version. |
| `src/process.rs` | Subprocesses as argument arrays with timeouts. The `Runner` trait lets tests replace `gh`. |
| `src/notes.rs`, `obsidian-plugin/` | Optional TaskNotes bridge: note-to-issue links and completion request/receipt files. |
| `agent-context/` | All model-facing text: the orchestrator skill (`SKILL.md`), the implementer and reviewer instructions it appends to their system prompts (`implementer.md`, `reviewer.md`), and the task brief template that `gho worktree` fills in (`brief.md`). |
| `package.json` | Pi package manifest, so `pi install git:github.com/rowantran/github-orchestrator` installs the skill and the agent status extension. |

## Decisions

- **No lifecycle management in code.** Launching, monitoring and retrying implementers is left to the orchestrator agent, so it can handle edge cases and choose how to run each implementer. The `[agents]` models are only stored and printed by `gho`; the orchestrator passes them to Pi.
- **Config files are the only way to configure.** `gho init` takes no options. It creates missing config files with what it can infer (your login from `gh`, the base branch from `origin/HEAD`), and the user edits them. Settings shared by every repository are global; each repository's Project and base branch are in its own file, kept with the global one instead of in the repository because they are personal. The files hold only values a person can read and write: the Project is set by URL, and `gho` looks up its ID when it needs it.
- **The working directory selects the repository.** The checkout and repository are never configured: `gho` uses the git checkout it runs in and the GitHub repository of its `origin`, so one installation serves every repository.
- **No local state.** "In progress" means the issue's branch exists or a draft PR comes from it; "ready for review" means an open PR that is not a draft comes from it. Deleting the branch (`wt remove -D`) makes an issue without a PR ready again.
- **Workstreams are overlapping sets, not issue parents.** Each `gho:workstream:NAME` label defines one group. A task can have any number of memberships; names containing slashes have no inherited membership. Labels preserve GitHub as the only task store. The dashboard's root is all issues in this repository's configured Project, not just the user's open queue.
- **A filtered graph is not a new schedule.** Compute status on the full dependency graph, then filter only visible nodes and edges. External dependencies remain in task details. Completed work stays visible; closed-but-not-completed issues remain a distinct state.
- **Pane focus is navigation, not lifecycle management.** The skill tags launched panes with repository and issue identities. The server only discovers and selects live panes and checks ownership again on every click. Nothing in Rust starts an agent or sends it input. The dashboard keeps only its current view in memory and never persists operational state.
- **Tailnet sharing is explicit.** `dashboard --tailscale-serve` keeps the backend on loopback and manages only its own foreground Serve session. The HTTP port defaults to 8080. Exact node-name Host/Origin allowances come from Tailscale status, never forwarded headers or browser input. Tailnet access rules are the authorization boundary; the HTML session token prevents cross-site API calls but is not a user login. No Funnel, privilege escalation, or reset of existing Serve configuration.
- **Only ready work starts.** An issue is ready when every blocker is done or ready for review. Blockers under review must form one chain of PRs, and the new branch starts from the top of it (`origin/<branch>`), so stacks build on pushed work that others can see. `gho worktree N` refuses other issues; `--base` is the explicit override.
- **The brief is deterministic.** `gho worktree` writes each issue's task brief from a template, so every agent gets the same facts in the same form, and the orchestrator does not write briefs itself. The brief lives in the worktree, in a self-ignoring `.gho/` directory, so it needs no shared Git configuration and is removed with the worktree.
- **Publishing a PR is the hand-off.** Implementers open a draft PR early, to review the skeleton on GitHub. A draft is unfinished work, so it does not count as ready for review and does not unblock dependents; marking the PR ready for review does. The workflow does not depend on agents remembering to ignore draft PRs.
- **PRs are found by branch.** GitHub ignores closing keywords on PRs that target a non-default branch, so a stacked PR is never linked to its issue. `gho` looks up open PRs by head branch `<owner>/gh-N` in the configured repository instead.
- **Waiting is deterministic and read-only.** Agents must not write their own polling loops or spend context on checks that find nothing. `gho wait` does the polling and returns one JSON result; agents run it as a background command. It never starts, stops, or sends input to an agent.
- **Agent activity comes from Pi, not the terminal.** Reading tmux panes would depend on how Pi draws its screen. The extension reports Pi's own lifecycle events (`agent_start`, `agent_settled`, dialogs, quit) and a heartbeat, so a dead agent is detected too. It is inert unless the launch passes `--gho-agent=NAME`. Status files are runtime state of a running agent, kept in the worktree's ignored `.gho/` directory, not task state.
- **A review is the unit of feedback.** `gho wait review` ends on a submitted review, so the implementer gets a whole batch of comments at once. Agents use the user's GitHub account, so their reviews are recognized by the `[agent:]` prefix. A cursor that the agent passes back, not local state, records which reviews were delivered. Without one, every review on the pull request counts, so a relaunched agent sees the whole history.
- **Completed means `COMPLETED`.** Issues closed as not planned or duplicate never unblock dependents or complete notes.
