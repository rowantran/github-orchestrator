---
name: github-orchestrator
description: Plan work as GitHub issues, find issues that are ready, create a worktree per issue with gho, and run implementer agents in those worktrees. Use when the user wants to plan or work through their GitHub task queue.
metadata:
  purpose: Instructions for the orchestrator agent that uses the gho CLI.
  audience: The interactive orchestrator agent the user talks to.
  injection: Installed as a Pi package (pi install git:github.com/rowantran/github-orchestrator); Pi advertises it and loads it on demand. Not for implementer agents.
---
<!-- Purpose: teach the orchestrator agent the gho workflow. Audience: orchestrator agent. Injection: Pi package skill, loaded when the task matches or via /skill:github-orchestrator. -->
# Orchestrate GitHub tasks with gho

You are the orchestrator. `gho` does three fixed jobs: register work, list ready work, and create worktrees. You decide the rest with the user: which tasks to start, how to launch and steer implementers, how to handle failures, and when to publish.

## Setup

If `gho` is not on PATH, ask the user to install it with `cargo install --locked --git https://github.com/rowantran/github-orchestrator`. If a command says the config is not found, help the user run `gho init --checkout REPO_PATH --project PROJECT_URL`, then `gho doctor`.

## Commands

- `gho task create --title TITLE --body-file FILE [--blocked-by N]... [--note VAULT_PATH]`: create an issue assigned to the user, add it to the queue Project, and record native "blocked by" links. Prints the issue URL.
- `gho ready --json`: issues with `state` `ready`: no branch yet, and every blocker is `done` or `ready_for_review` (it has an open PR). Only ready issues can be started. A non-empty `stack_on` lists the blockers under review the issue will be stacked on. Add `--all` to also see `blocked`, `in_progress` (branch exists, no PR) and `ready_for_review` (open PR, in `pull_request`) issues. Each entry has `number`, `title`, `url`, `body`, `state`, `branch`, `worktree`, and `blockers`; each blocker has its own `state` (`done`, `closed`, `ready_for_review`, `in_progress`, `ready` or `blocked`), local `branch`/`worktree`, and closing `pull_requests`.
- `gho worktree N [--base REF]`: create branch `<owner>/gh-N` in a new worktree for a ready issue. It starts from the top of `stack_on` (the latest `origin/<owner>/gh-M`), or from the latest `origin/<base branch>` when `stack_on` is empty. It refuses issues that are not ready and says why. `--base REF` skips that check and starts from REF. Prints JSON with `path`, `branch`, `base` and `base_commit`.

## Plan

Discuss the goal and any real ambiguity with the user. Propose issue bodies with: goal, scope and exclusions, relevant code paths, implementation steps, acceptance criteria, and verification commands. Add a blocker only when one task needs another task's result. Create the issues after the user agrees. Never put credentials in issues.

## Run tasks

1. Run `gho ready --json` and agree with the user which issues to start and how many at once, unless they already said.
2. Run `gho worktree N` for each one.
   - If `stack_on` is not empty, the worktree is stacked on those blockers' pull requests; tell the user. Do not start issues that are not ready. To start one anyway (for example on unpublished work), ask the user first, then use `gho worktree N --base <branch>`.
3. Launch one implementer per worktree, with the worktree as its working directory. Pick the mechanism that fits:
   - Sandboxed Pi: run `isara pi run -- -p "<brief>"` from the worktree as a background shell command.
   - Or your harness's subagent tool, with its working directory set to the worktree.
4. The brief should contain: the issue URL, title and body; the branch and base; "work only in this worktree"; the verification commands; "commit your work on this branch with a message that references #N; do not push"; and "finish with a summary, the checks you ran with results, and anything that blocked you".
5. Watch progress. Answer questions, steer, stop, or relaunch as needed.
6. When an implementer finishes, review the diff yourself (`git -C PATH diff BASE_COMMIT`, plus `git -C PATH status` for uncommitted files), check its test results, and report to the user.
7. Push and open a PR only when the user asks: `git -C PATH push -u origin BRANCH`, then `gh pr create --draft --head BRANCH --base BASE --title ... --body "Closes #N ..."`. For stacked work, BASE is the upstream branch, not the main branch. Never merge.

## Edge cases

- `gho ready --all` shows an issue as `in_progress`: its branch exists already. Continue in its `worktree`; do not make a second one.
- An issue is `ready_for_review` while its PR is open. Review feedback is applied on its branch; afterwards, rebase issues stacked on it onto the updated branch.
- To restart a task from scratch, ask the user first: this deletes the branch and its unmerged commits. Run `wt remove --foreground -D BRANCH` (add `-f` if it has uncommitted changes), then `gho worktree N` again.
- When an upstream PR merges, rebase the stacked branch onto `origin/<base branch>` and change its PR base.
- A blocker closed as not planned or duplicate never counts as done. Tell the user; do not work around it.
