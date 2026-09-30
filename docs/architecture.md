<!-- Purpose: explain responsibilities and module layout. Audience: maintainers. Injection: documentation only; not loaded into agents. -->
# Architecture

`gho` gives an orchestrator agent a few deterministic operations. Everything that needs judgment stays with the agent and the user.

```text
You ↔ orchestrator agent (Pi + the github-orchestrator skill)
        │ gho task create      → GitHub issue + Project + blocked-by links
        │ gho ready --json     → reads GitHub queue + local branches
        │ gho worktree N       → git fetch + wt switch --create
        ▼
   implementer agents, one per worktree
   (launched, steered and reviewed by the orchestrator: isara pi run, subagents, ...)
        │
        ▼
   push + draft PR when you ask → you review and merge
```

## Who owns what

| Owner | Responsibility |
| --- | --- |
| GitHub | Tasks: title, body, assignee, Project membership, blockers, open/closed and close reason. |
| Git checkout | Work in progress: branch `<owner>/gh-N` and its worktree. |
| `gho` | Reads the two above to classify issues; creates issues and worktrees. No local database. |
| Orchestrator agent | Which tasks to start, launching and managing implementers, retries, stacking, review, publishing. |
| You | Plan approval, what to run, when to publish, merging. |

## Modules

| Module | Responsibility |
| --- | --- |
| `src/cli.rs` | Commands, argument parsing (clap), output. `src/main.rs` only calls it. |
| `src/config.rs` | Queue config (`[queue]`, optional `[obsidian]`) and the branch naming rule. Unknown keys are rejected. |
| `src/domain.rs` | Value types: `IssueRef`, `Issue`, `PullRequest`, and the state enums. |
| `src/github.rs` | GitHub reads (queue, issue, blockers, linked PRs) and issue creation, through `gh`. Responses are decoded into strict types, so missing or partial API data is an error instead of looking like an empty queue. |
| `src/work.rs` | `survey()`: classify each queue issue as `ready`, `blocked` or `in_progress`. The `Issues` and `Branches` traits let tests replace GitHub and git. |
| `src/workspace.rs` | Git and Worktrunk: fetch the base, list worktrees, create the issue's worktree. |
| `src/process.rs` | Subprocesses as argument arrays with timeouts. The `Runner` trait lets tests replace `gh`. |
| `src/notes.rs`, `obsidian-plugin/` | Optional TaskNotes bridge: note-to-issue links and completion request/receipt files. |
| `agent-context/` | All model-facing text: the orchestrator skill. |
| `package.json` | Pi package manifest, so `pi install git:github.com/rowantran/github-orchestrator` installs the skill. |

## Decisions

- **No lifecycle management in code.** Launching, monitoring and retrying implementers is left to the orchestrator agent, so it can handle edge cases and choose how to run each implementer.
- **No local state.** "In progress" means the issue's branch exists. Deleting the branch (`wt remove -D`) makes the issue ready again.
- **Stacking is allowed.** `gho worktree N --base BRANCH` builds on unmerged work. Readiness still requires blockers closed as completed; stacking is the orchestrator's explicit choice for blocked issues.
- **Completed means `COMPLETED`.** Issues closed as not planned or duplicate never unblock dependents or complete notes.
