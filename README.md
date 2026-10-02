# GitHub Orchestrator

`gho` is a small CLI that an orchestrator agent uses to work through your GitHub issue queue. Its core operations are:

1. **Register work:** create GitHub issues assigned to you, added to your Project, with native "blocked by" links.
2. **Find ready work:** list open issues in your queue that you can start: every blocker is done, or has an open pull request to stack on.
3. **Create a worktree:** make branch `<owner>/gh-N` for a ready issue in a new Worktrunk worktree, from the latest base branch or stacked on its blockers' pull requests. The worktree gets a task brief for the issue's agents in `.gho/brief.md`, which Git ignores.
4. **Wait:** block until agents settle (`gho wait agents`) or until someone submits a review on a pull request (`gho wait review`). Agents run these in the background, so they need no polling logic of their own and use no context while nothing happens.

You can also group tasks into overlapping workstreams and view their dependencies in a local dashboard. The dashboard opens PR links and selects existing agent panes in tmux; it does not launch or manage agents.

The agent you talk to handles the implementation workflow. It launches an implementer agent in each worktree, in its own tmux window. The implementer first commits a skeleton (pseudocode and stubs at the real paths) and opens a draft PR with it. You review the skeleton in PR comments, and the implementer answers there, with every comment prefixed `[agent:]`. When you approve, it implements the change, pushes it to the same PR, and marks the PR ready for review. Then the orchestrator launches a reviewer agent on it. The skill in [`agent-context/github-orchestrator/SKILL.md`](agent-context/github-orchestrator/SKILL.md) tells the orchestrator how; `implementer.md` and `reviewer.md` next to it are the other agents' standing instructions. This repository is a Pi package that ships them, and a Pi extension that records each agent's activity for `gho wait agents`.

GitHub is the only task store. `gho` keeps no local state: a task is "in progress" when its branch exists or it has a draft pull request, and "ready for review" when an open pull request that is not a draft comes from that branch.

## Install and configure

You need Rust (`cargo`), Git, an authenticated GitHub CLI (`gh` 2.94 or later, for `--blocked-by`) with Projects scope, Worktrunk (`wt`), and Pi.

```sh
# The gho CLI
cargo install --locked --git https://github.com/rowantran/github-orchestrator
# The orchestrator skill, as a Pi package
pi install git:github.com/rowantran/github-orchestrator

gh auth refresh -s project
cd /path/to/your/clone
gho init      # creates the config files below if they are missing
$EDITOR ~/.config/github-orchestrator/repos/OWNER/REPO.toml   # set project_url
gho doctor
```

You configure `gho` by editing two files. `gho init` takes no options. It creates whichever file is missing, fills in what it can infer, and never overwrites a file:

- `~/.config/github-orchestrator/config.toml`: settings shared by every repository. `gho init` fills in `owner` with your GitHub login (from `gh`).

  ```toml
  owner = "rowantran"                                   # your queue is the issues assigned to you; branches are <owner>/gh-N
  [agents]                                              # optional Pi --model patterns; unset means your Pi default
  implementer_model = "anthropic/claude-opus-4-5:high"
  reviewer_model = "openai/gpt-5"
  [obsidian]                                            # optional TaskNotes bridge
  vault = "/path/to/vault"
  ```

- `~/.config/github-orchestrator/repos/OWNER/REPO.toml`: settings for one repository. `gho init` creates it when you run it in a clone of that repository, and fills in `base_branch` from `origin/HEAD` (else `main`). You fill in `project_url`.

  ```toml
  project_url = "https://github.com/users/rowantran/projects/123"
  base_branch = "main"
  ```

The repository and checkout are not configured: `gho` uses the git checkout you run it in (any worktree or subdirectory of it) and the GitHub repository of its `origin`. Unknown keys are an error. `gho doctor` checks that you can read the Project and warns when an agent model is not set. `gho config` prints the loaded config as JSON.

Use another config directory with `GHO_CONFIG_DIR` or `gho --config-dir PATH`. Worktrees go wherever your Worktrunk configuration puts them.

To update later: rerun the `cargo install` command and `pi update git:github.com/rowantran/github-orchestrator`.

## Use it through the orchestrator

Start Pi in your clone. It lists the `github-orchestrator` skill and loads it when you ask to plan or run queue work; `/skill:github-orchestrator` forces it. The commands the skill uses:

```sh
gho task create --title "One bounded change" --body-file task.md --blocked-by 41
gho ready --json            # ready issues; --all adds blocked, in-progress and ready-for-review ones
gho worktree 42             # new worktree from the latest origin/main
gho worktree 43             # ready with stack_on [42]: starts from origin/rowantran/gh-42
gho worktree 44 --base rowantran/gh-42   # start any issue, ready or not, from an explicit branch or commit
gho config                  # config as JSON, including agents.implementer_model and agents.reviewer_model
gho wait agents             # block until an agent settles; prints JSON with a cursor for --since
gho wait review             # (implementers) block until a review is submitted on this branch's PR
```

**States.** `gho` classifies every issue, in this order:

| State | Meaning |
| --- | --- |
| `done` | Closed as *completed*. |
| `closed` | Closed as not planned or duplicate. Never unblocks dependents. |
| `ready_for_review` | An open pull request that is not a draft comes from `<owner>/gh-N`. |
| `in_progress` | An open draft pull request comes from `<owner>/gh-N`, or the branch exists locally with no open pull request. |
| `ready` | No branch yet, and every blocker is `done` or `ready_for_review`. |
| `blocked` | Anything else. |

Only `ready` issues can be picked up. A ready issue's `stack_on` lists its blockers that are ready for review, bottom first; `gho worktree N` starts from the last one's branch, or from the latest base branch when the list is empty. Blockers under review must lie on one chain of pull requests (each based on the branch below it), because a branch can only start from one of them; otherwise the issue is blocked. `gho` finds pull requests by head branch, because GitHub does not link stacked pull requests to issues through "Closes #N". Only issues in the configured repository have branches, so blockers elsewhere are never `in_progress` or `ready_for_review`.

`gho ready` lists open issues assigned to you in the Project, with each blocker's state, local branch, worktree and pull requests. `gho worktree N` refuses issues that are not ready unless you pass `--base`.

**Task brief.** `gho worktree N` fills in the template [`agent-context/brief.md`](agent-context/brief.md) and writes it to `.gho/brief.md` in the new worktree. The brief gives the issue, the branch, and the base branch that the pull request targets. The base branch is the branch that the worktree started from, or the configured base branch when `--base` is a commit or tag. `.gho/` contains its own `.gitignore`, so the brief is never committed. The orchestrator gives the brief to the implementer and reviewer agents as their first message.

## Waiting for agents and reviews

Both commands block, check at an interval, and print one JSON object when they end. Each prints a `cursor`; pass it to the next call as `--since CURSOR`, so the events it already reported do not end that call again. `--timeout SECONDS` gives up with `"result": "timeout"`, and `--interval SECONDS` sets how often they check. After a first successful check, up to five consecutive failed checks (for example, a network error) are retried.

**`gho wait agents [N | N/AGENT]... [--all]`** is for the orchestrator. It ends when an agent settles: the agent finished its run and waits for a message, waits for an answer to a dialog in its terminal (`prompting`), quit (`exited`), or stopped updating its status without quitting (`lost`, after 60 seconds). Without arguments it watches every agent in every issue worktree; `42` watches the agents in issue 42's worktree, and `42/reviewer` one of them. `--all` ends only when every watched agent is settled at the same time. The output lists each agent's state, whether it is `new` since the cursor, the end of its last message, and its Pi session file.

The agent statuses come from the Pi extension in [`extensions/agent-status.mjs`](extensions/agent-status.mjs), which this package installs. It does nothing unless Pi starts with `--gho-agent=NAME`, as the skill's launch commands do. Then it writes `.gho/agents/NAME.json` in the agent's working directory (the worktree) on every state change and every 5 seconds. `gho wait agents` only reads these files. It waits up to 30 seconds for an expected status to appear after a launch.

**`gho wait review [--pr N]`** is for implementers. It ends when someone submits a review on the pull request (by default the open pull request from the current branch), or when the pull request is merged or closed. It prints each new review with its body and inline comments. Comments in a pending review stay invisible until you submit the review, so the implementer gets them as one batch. Reviews by agents (every text starts with `[agent:]`) are ignored. GitHub stores **Add single comment** and replies outside a pending review as one-comment reviews, so those also end the wait; use **Start a review** to batch comments. Comments in the pull request's conversation tab are not reviews and do not end the wait. It checks GitHub every 30 seconds by default.

## Workstreams and the graph dashboard

A **workstream** is a named subset of the tasks in your repository. Use one for a subproject, feature, or cross-cutting effort. Tasks can belong to several workstreams, and their blockers do not need to belong to the same workstream.

```sh
gho workstream create project-a
gho workstream create project-a/feature-1
gho workstream create shared-platform
gho workstream add project-a 41 42 43
gho workstream add project-a/feature-1 42 43
gho workstream add shared-platform 42 50
gho workstream remove project-a/feature-1 43
gho workstream list --json

# Assign memberships while creating a task (create the workstreams first):
gho task create --title "One bounded change" --body-file task.md \
  --workstream project-a --workstream project-a/feature-1

# Run from a configured repository checkout, then open the printed URL:
gho dashboard
# Optional: choose a port and restrict focus to an exact tmux session name:
gho dashboard --port 8080 --tmux-session agents
# Optional: share through Tailscale Serve, with no manual proxy configuration:
gho dashboard --tailscale-serve --port 8080 --tmux-session agents
```

Memberships are GitHub labels named `gho:workstream:NAME`. They survive across machines and can also be edited on GitHub. Adding or removing a membership preserves all other labels. Names use letters, digits, `.`, `_`, `-`, and `/`, with each slash-separated segment starting with a letter or digit; the name is at most 35 characters. Names are case-insensitive on GitHub. A slash is just part of a name: `project-a/feature-1` does **not** automatically include a task in `project-a`. Add both memberships when you want both views. Empty workstreams remain selectable. Membership commands accept issue numbers or full issue URLs from this repository.

The dashboard's **All tasks** view includes all issues in the configured repository and Project, regardless of assignee, including completed, closed, and archived Project items. This is broader than `gho ready`, which still shows only your open queue. Labels alone do not add an issue to the Project.

- Select a workstream to see its dependency graph. Arrows point from a blocker to its dependent task.
- Colors and text distinguish **Blocked**, **Ready**, **In progress**, **Ready for review**, **Complete**, and **Closed**. Closed means not planned or duplicate, not completed.
- Filtering never recalculates readiness. A task blocked by something outside the visible graph stays blocked. Select it to inspect all blockers, including links outside this view.
- Select a task to open its GitHub issue, draft/published/merged PRs, or focus an existing agent pane. Multiple matching panes appear in a selector.
- Search tasks, pan the graph, zoom, or fit it to the viewport. Refresh manually or enable the optional 60-second refresh. A failed refresh reports an error instead of replacing the graph with an empty result.

**tmux focus.** Run the dashboard on the machine and tmux server where the agents run. The orchestrator skill tags agent panes with `@gho_repo` and `@gho_issue`. Existing untagged panes also work when exactly one live pane has the task worktree root as its current directory. Ambiguous matches and panes in subdirectories need tags. Without `--tmux-session`, discovery uses the inherited tmux session when run inside tmux, otherwise the default server. Focus selects the verified window and pane; clients attached to that session see the selection. It does not open a terminal, attach a client, switch unrelated sessions, or send input. Missing tmux disables focus without hiding tasks.

Each refresh reads the configured Project's items directly, including archived items, then fetches matching issues and PR links in batches. It does not scan the repository's issue or pull request history. Large Projects can take longer to load. A refresh has a 90-second subprocess budget; failures keep the last successful view and show an error. Automatic refresh is off by default to avoid unnecessary GitHub API use; it waits for the preceding request to finish and pauses in a hidden tab.

**Local access.** The dashboard binds only to `127.0.0.1`, uses an available port by default, and stops with Ctrl-C. It serves bundled assets with no frontend build or external CDN. API calls require a per-process token; foreign hosts and origins are rejected. No GitHub credentials are sent to the browser and no task database is created. For a remote machine, use an SSH tunnel with the same local and remote port, then open `http://127.0.0.1:PORT/`. Do not expose the dashboard through a public proxy.

### Tailscale access

Run `gho dashboard --tailscale-serve --tmux-session dune-storage` on the machine hosting the agent panes. It detects the node's Tailscale DNS name and prints an HTTP URL such as `http://rowan-v2-dev:8080/`. Both the short MagicDNS name and the full Tailscale DNS name are accepted. The browser machine must be on the tailnet and able to resolve the name.

With this flag, `--port` selects the **tailnet HTTP port** (8080 when omitted or zero). The backend still binds only to `127.0.0.1`, on a separate OS-selected port. `gho` starts a temporary foreground `tailscale serve` process, confirms its mapping, and allows only the detected node names and the backend's loopback address. Host, Origin, API-token, and content-security checks remain enabled. It does not enable Funnel or expose a public internet endpoint.

Tailscale must be installed, running, and logged in, with MagicDNS enabled and foreground Serve support (checked against Tailscale 1.102.2). Your OS user must have permission to configure Serve; `gho` does not run `sudo`, log you in, or change tailnet policy. It refuses a port already configured in Serve or Funnel rather than overwriting it. Other services are left unchanged. Ctrl-C or SIGTERM stops the owned Serve process during shutdown; an active GitHub refresh may take up to its 90-second deadline to finish. No persistent Serve mapping is created.

**Access is controlled by your tailnet rules, not a dashboard login.** Anyone allowed to reach this port can read the Project's task data and select existing tmux panes. Restrict access accordingly. The page uses HTTP inside Tailscale's encrypted network, not HTTPS. Do not put a public proxy in front of it.

## Optional TaskNotes bridge

Links Obsidian task notes to GitHub issues and marks the note done when all its issues are completed.

```sh
# From a clone of this repository (the plugin is not part of the cargo install):
(cd obsidian-plugin && npm ci && npm test && npm run build)
cargo run -- notes install    # then enable the plugin in Obsidian yourself
gho notes link "Tasks/example.md" 42 43
gho notes complete          # request completion for notes whose issues are all completed
```

`notes link` replaces a note's issue set; `task create --note` adds to it. `notes complete` skips pending or accepted requests; use `--retry` for failed or stale ones. See the [plugin README](obsidian-plugin/README.md).

## Development

Work from a clone: `cargo run -- …`. To load your local skill edits in Pi instead of the GitHub version, `pi install /absolute/path/to/clone` (and `pi remove` the git source).

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
(cd obsidian-plugin && npm ci && npm test && npm run build)
(cd dashboard && npm test && npm run build)
npm test                    # the agent status extension
# Browser integration tests: see tests/dashboard_e2e/README.md
```

Tests use temporary repositories, a local bare repository in place of GitHub, and a fake `gh`. They never write to real GitHub or a real vault. The Worktrunk tests run when `wt` is on `PATH`.

See [docs/architecture.md](docs/architecture.md) for the module layout.
