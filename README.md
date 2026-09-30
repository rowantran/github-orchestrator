# GitHub Orchestrator

`gho` is a small CLI that an orchestrator agent uses to work through your GitHub issue queue. It does three things:

1. **Register work:** create GitHub issues assigned to you, added to your Project, with native "blocked by" links.
2. **Find ready work:** list open issues in your queue whose blockers are all closed as completed.
3. **Create a worktree:** make branch `<owner>/gh-N` in a new Worktrunk worktree, from the latest base or stacked on another branch.

The agent you talk to does everything else: it launches implementer agents in the worktrees, steers them, reviews their work, and pushes or opens PRs when you ask. The skill in [`agent-context/github-orchestrator/SKILL.md`](agent-context/github-orchestrator/SKILL.md) tells it how; this repository is a Pi package that ships it.

GitHub is the only task store. `gho` keeps no local state: a task is "in progress" when its branch exists.

## Install and configure

You need Rust (`cargo`), Git, an authenticated GitHub CLI (`gh`) with Projects scope, Worktrunk (`wt`), and Pi.

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
gho ready --json            # ready issues; --all adds blocked and in-progress ones
gho worktree 42             # new worktree from the latest origin/main
gho worktree 43 --base rowantran/gh-42   # stack on unmerged work
```

**Readiness rule:** an issue is ready when it is open, assigned to you, in the Project, has no `<owner>/gh-N` branch yet, and every blocker is closed as *completed*. Blockers closed as not planned or duplicate do not count. For blocked issues, `gho ready --all --json` shows each blocker's local branch, worktree and linked PRs, so the orchestrator can stack on them.

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
