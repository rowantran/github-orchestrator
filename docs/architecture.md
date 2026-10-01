<!-- Purpose: explain responsibilities and module layout. Audience: maintainers. Injection: documentation only; not loaded into agents. -->
# Architecture

`gho` gives an orchestrator agent a few deterministic operations. Everything that needs judgment stays with the agent and the user.

```text
You ↔ orchestrator agent (Pi + the github-orchestrator skill)
        │ gho task create      → GitHub issue + Project + blocked-by links
        │ gho ready --json     → reads GitHub queue, open PRs by branch, local branches
        │ gho worktree N       → git fetch + wt switch --create
        │ gho config           → agent models from the config
        ▼
   implementer agents, one per worktree, each in a tmux window
   (skeleton → agreed with you in that window → implementation → push + draft PR)
        │
        ▼
   reviewer agent per PR → orchestrator relays findings → you review and merge
```

## Who owns what

| Owner | Responsibility |
| --- | --- |
| GitHub | Tasks: title, body, assignee, Project membership, blockers, open/closed and close reason. |
| Git checkout | Work in progress: branch `<owner>/gh-N` and its worktree. Once pushed with an open PR, the issue is ready for review. |
| `gho` | Reads the two above to classify issues; creates issues and worktrees. No local database. |
| Orchestrator agent | Which tasks to start, launching and managing implementers, retries, stacking, review, publishing. |
| You | Plan approval, what to run, when to publish, merging. |

## Modules

| Module | Responsibility |
| --- | --- |
| `src/cli.rs` | Commands, argument parsing (clap), output. `src/main.rs` only calls it. |
| `src/config.rs`, `src/config_template.toml` | Queue config (`[queue]`, optional `[obsidian]` and `[agents]`) and the branch naming rule. Unknown keys are rejected. `gho init` writes the template; the user fills it in. |
| `src/domain.rs` | Value types: `IssueRef`, `Issue`, `PullRequest`, and the state enums. |
| `src/github.rs` | Looks up the Project ID from the configured Project URL once per run. GitHub reads (queue, issue, blockers, linked PRs) and issue creation, through `gh`. Responses are decoded into strict types, so missing or partial API data is an error instead of looking like an empty queue. |
| `src/work.rs` | `survey()` (the queue) and `classify()` (one issue): the `State` of each issue and its blockers: `blocked`, `ready { stack_on }`, `in_progress`, `ready_for_review`, `done` or `closed`. The `Issues` and `Branches` traits let tests replace GitHub and git. |
| `src/workspace.rs` | Git and Worktrunk: fetch the base, list worktrees, create the issue's worktree. |
| `src/process.rs` | Subprocesses as argument arrays with timeouts. The `Runner` trait lets tests replace `gh`. |
| `src/notes.rs`, `obsidian-plugin/` | Optional TaskNotes bridge: note-to-issue links and completion request/receipt files. |
| `agent-context/` | All model-facing text: the orchestrator skill (`SKILL.md`) and the implementer and reviewer instructions it appends to their system prompts (`implementer.md`, `reviewer.md`). |
| `package.json` | Pi package manifest, so `pi install git:github.com/rowantran/github-orchestrator` installs the skill. |

## Decisions

- **No lifecycle management in code.** Launching, monitoring and retrying implementers is left to the orchestrator agent, so it can handle edge cases and choose how to run each implementer. The `[agents]` models are only stored and printed by `gho`; the orchestrator passes them to Pi.
- **The config file is the only way to configure.** `gho init` takes no options and writes a commented template; the user edits it. The file holds only values a person can read and write: the Project is set by URL, and `gho` looks up its ID when it needs it.
- **No local state.** "In progress" means the issue's branch exists; "ready for review" means an open PR comes from it. Deleting the branch (`wt remove -D`) makes an issue without a PR ready again.
- **Only ready work starts.** An issue is ready when every blocker is done or ready for review. Blockers under review must form one chain of PRs, and the new branch starts from the top of it (`origin/<branch>`), so stacks build on pushed work that others can see. `gho worktree N` refuses other issues; `--base` is the explicit override.
- **PRs are found by branch.** GitHub ignores closing keywords on PRs that target a non-default branch, so a stacked PR is never linked to its issue. `gho` looks up open PRs by head branch `<owner>/gh-N` in the configured repository instead.
- **Completed means `COMPLETED`.** Issues closed as not planned or duplicate never unblock dependents or complete notes.
