<!-- Purpose: the task brief for one issue. Audience: implementer and reviewer agents. Injection: `gho worktree` fills in the {{placeholders}}, drops this comment, and writes the result to .gho/brief.md in the new worktree; the orchestrator passes that file as the agent's first message. -->
# Issue #{{number}}: {{title}}

- Issue: {{url}}
- Branch: `{{branch}}`, checked out in this worktree.
- Base branch: `{{base_branch}}`. The pull request targets this branch.

The issue gives the goal, scope, acceptance criteria and verification commands. Read it and its comments first:

```sh
gh issue view {{number}} --repo {{repo}} --comments
```
