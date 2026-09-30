# GitHub Orchestrator

`gho` is a small CLI that an orchestrator agent uses to work through your GitHub issue queue. It does three things:

1. **Register work:** create GitHub issues assigned to you, added to your Project, with native "blocked by" links.
2. **Find ready work:** list open issues in your queue that you can start: every blocker is done, or has an open pull request to stack on.
3. **Create a worktree:** make branch `<owner>/gh-N` for a ready issue in a new Worktrunk worktree, from the latest base branch or stacked on its blockers' pull requests.

The agent you talk to does everything else: it launches implementer agents in the worktrees, steers them, reviews their work, and pushes or opens PRs when you ask. The skill in [`agent-context/github-orchestrator/SKILL.md`](agent-context/github-orchestrator/SKILL.md) tells it how; this repository is a Pi package that ships it.

GitHub is the only task store. `gho` keeps no local state: a task is "in progress" when its branch exists, and "ready for review" when an open pull request comes from that branch.

## Install and configure

You need Rust (`cargo`), Git, an authenticated GitHub CLI (`gh` 2.94 or later, for `--blocked-by`) with Projects scope, Worktrunk (`wt`), and Pi.

```sh
# The gho CLI
cargo install --locked --git https://github.com/rowantran/github-orchestrator
# The orchestrator skill, as a Pi package
pi install git:github.com/rowantran/github-orchestrator

gh auth refresh -s project
gho init --checkout /absolute/path/to/isara --project https://github.com/users/rowantran/projects/123
gho doctor
```

`--repo` defaults to the checkout's GitHub `origin` and `--owner` to the authenticated user. `--base` sets the default base branch (`main`). Add `--vault /path/to/vault` to use the optional Obsidian bridge.

The config is written to `~/.config/github-orchestrator/config.toml`. Override it with `GHO_CONFIG` or `gho --config PATH`. Worktrees go wherever your Worktrunk configuration puts them.

To update later: rerun the `cargo install` command and `pi update`.

## Use it through the orchestrator

Start Pi as usual. It lists the `github-orchestrator` skill and loads it when you ask to plan or run queue work; `/skill:github-orchestrator` forces it. The commands the skill uses:

```sh
gho task create --title "One bounded change" --body-file task.md --blocked-by 41
gho ready --json            # ready issues; --all adds blocked, in-progress and ready-for-review ones
gho worktree 42             # new worktree from the latest origin/main
gho worktree 43             # ready with stack_on [42]: starts from origin/rowantran/gh-42
gho worktree 44 --base rowantran/gh-42   # start any issue, ready or not, from an explicit branch or commit
```

**States.** `gho` classifies every issue, in this order:

| State | Meaning |
| --- | --- |
| `done` | Closed as *completed*. |
| `closed` | Closed as not planned or duplicate. Never unblocks dependents. |
| `ready_for_review` | An open pull request (draft or not) comes from `<owner>/gh-N`. |
| `in_progress` | The branch `<owner>/gh-N` exists locally, with no open pull request. |
| `ready` | No branch yet, and every blocker is `done` or `ready_for_review`. |
| `blocked` | Anything else. |

Only `ready` issues can be picked up. A ready issue's `stack_on` lists its blockers that are ready for review, bottom first; `gho worktree N` starts from the last one's branch, or from the latest base branch when the list is empty. Blockers under review must lie on one chain of pull requests (each based on the branch below it), because a branch can only start from one of them; otherwise the issue is blocked. `gho` finds pull requests by head branch, because GitHub does not link stacked pull requests to issues through "Closes #N". Only issues in the configured repository have branches, so blockers elsewhere are never `in_progress` or `ready_for_review`.

`gho ready` lists open issues assigned to you in the Project, with each blocker's state, local branch, worktree and pull requests. `gho worktree N` refuses issues that are not ready unless you pass `--base`.

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
```

Tests use temporary repositories, a local bare repository in place of GitHub, and a fake `gh`. They never write to real GitHub or a real vault. The Worktrunk tests run when `wt` is on `PATH`.

See [docs/architecture.md](docs/architecture.md) for the module layout.
