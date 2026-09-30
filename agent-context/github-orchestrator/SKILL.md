---
name: github-orchestrator
description: Use when the user wants to handle nontrivial work (more than one PR required) by using the github-orchestrator (gho) tool. The tool facilitates breaking up a plan into a tree of GitHub issues, then dispatching implementer agents to handle those issues.
metadata:
  purpose: Instructions for the orchestrator agent that uses the gho CLI.
  audience: The interactive orchestrator agent the user talks to.
  injection: Installed as a Pi package (pi install git:github.com/rowantran/github-orchestrator); Pi advertises it and loads it on demand. Not for implementer agents.
---
<!-- Purpose: teach the orchestrator agent the gho workflow. Audience: orchestrator agent. Injection: Pi package skill, loaded when the task matches or via /skill:github-orchestrator. -->
# Orchestrate nontrivial work with github-orchestrator (gho)

`gho` performs three fixed jobs: register work, list ready work, and create worktrees.
You decide the rest with the user: which tasks to create, how to launch and steer implementers, and when to publish.

## Commands

- `gho task create --title TITLE --body-file FILE [--blocked-by N]... [--note VAULT_PATH]`: create an issue assigned to the user, add it to the configured project, and record native "blocked by" dependency information. Use this when breaking up the plan into a series of issues.
- `gho ready --json`: Use this when determining which issue (if any) to start next. Add `--all` to also see `blocked`, `in_progress` (branch exists, no PR) and `ready_for_review` (open PR, in `pull_request`) issues.
- `gho worktree N [--base REF]`: Use this once ready to start implementing issue N. It uses Worktrunk (`wt`) to create a branch `<owner>/gh-N` in a new worktree for a ready issue.
- `gho config`: prints the config as JSON. `agents.implementer_model` and `agents.reviewer_model` are the Pi models to launch agents with.

## Step 1: Plan

Start by discussing the goal with the user.
Begin by proposing a high-level plan that outlines which components we need to create or modify.
Then start breaking the high-level plan down into GitHub issues.

Each issue should have a brief, precise title. It should have a body with: goal, scope, acceptance criteria, and verification commands. Add blockers to indicate the order that tasks need to be implemented in.

## Step 2: Implement

Implementers and reviewers get their standing instructions from two files in this skill's directory:

- `implementer.md`: skeleton first, agree on it with the user in the implementer's window, implement, then open a draft PR.
- `reviewer.md`: check the PR against the issue and the approved skeleton, and report.

Once the above plan is complete:

1. Run `gho ready --json` and agree with the user which issues to start and how many at once, unless they already said.
2. Run `gho worktree N` for each one.
   - Generally, only start issues that are ready, with or without pending dependencies that they need to be stacked on.
   - In certain situations, we may want to start a non-ready issue anyway (for example if it depends on two disjoint issues that are both in review separately, so the CLI detects it as not ready, but  we want to merge those two dependencies into a new base branch so we can start anyways). In that case, ask the user first, then use `gho worktree N --base <branch>`.
3. Run `gho config` to get the models. Launch agents only with the configured model, never with Pi's default. If a model is not set, ask the user which model to use and suggest adding it under `[agents]` in the config.
4. Write the brief to a file outside the worktree. It should contain: the issue URL, title and body; the branch and the base branch (for a stacked issue, the blocker branch it starts from; the PR must target it); the verification commands.
5. Launch one implementer per worktree in a new tmux window titled "#N: <short-slug-version-of-issue-title>", with the worktree as its working directory. Run Pi interactively (no `-p`), so the user can discuss the skeleton in that window:

   ```sh
   tmux new-window -n "#N: <slug>" -c <worktree> \
     'isara sandbox pi -- --model <implementer_model> --append-system-prompt "$(cat <skill dir>/implementer.md)" "$(cat <brief file>)"'
   ```

   Use absolute paths. The `$(cat …)` expansions run outside the sandbox, so the sandbox does not need to read those files. Do not pass the path of `implementer.md` directly: if Pi cannot read the file, it silently uses the path itself as the prompt text.
6. Watch progress for all active implementers (`tmux capture-pane -p -t <window>`, `gho ready --all`). When an implementer is waiting for skeleton review, tell the user which window to go to; do not review or approve the skeleton for them. Answer other questions, steer (`tmux send-keys -t <window> '<message>' Enter`), stop, or relaunch as needed. Bubble up to the user for information when facing ambiguity that you can't safely resolve on your own.
7. When an implementer has opened its draft PR (the issue shows as `ready_for_review`), launch a reviewer in the same worktree the same way, but with `--model <reviewer_model>`, `reviewer.md`, a brief that also names the PR URL, and "Review " prepended to the window title.
8. Pass the reviewer's blocking findings to the implementer and have it fix and push them. Review again if needed.
