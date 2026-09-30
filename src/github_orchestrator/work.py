"""Classify queue issues as ready, blocked or in progress. Reads GitHub and git; changes nothing."""

from __future__ import annotations

from .domain import Issue
from .github import GitHub
from .workspace import Workspace


def _pull_requests(issue: Issue) -> list[dict]:
    return [{"url": pr.url, "state": pr.state, "head": pr.head, "base": pr.base} for pr in issue.pull_requests]


def survey(github: GitHub, workspace: Workspace) -> list[dict]:
    """One entry per open queue issue.

    - in_progress: the issue's branch already exists (gho worktree ran, or someone made it by hand).
    - ready: every blocker is closed as completed.
    - blocked: otherwise. Blocker details say which blockers have a local branch or PR to stack on.
    """
    config = workspace.config
    worktrees = workspace.worktrees()

    def local(repo: str, number: int) -> tuple[str | None, str | None]:
        if repo.lower() != config.repo.lower():
            return None, None
        branch = config.branch(number)
        if branch in worktrees:
            return branch, worktrees[branch]
        return (branch, None) if workspace.branch_exists(branch) else (None, None)

    result = []
    for issue in github.queue():
        branch, path = local(issue.ref.repo, issue.ref.number)
        blockers = []
        for ref in issue.blockers:
            blocker = github.issue(ref)
            blocker_branch, blocker_path = local(ref.repo, ref.number)
            blockers.append({
                "number": ref.number, "repo": ref.repo.lower(), "url": ref.url, "title": blocker.title,
                "done": blocker.completed, "state": blocker.state, "state_reason": blocker.state_reason,
                "branch": blocker_branch, "worktree": blocker_path, "pull_requests": _pull_requests(blocker),
            })
        if branch:
            state = "in_progress"
        elif all(item["done"] for item in blockers):
            state = "ready"
        else:
            state = "blocked"
        result.append({
            "number": issue.ref.number, "title": issue.title, "url": issue.ref.url, "state": state,
            "branch": branch or config.branch(issue.ref.number), "worktree": path,
            "blockers": blockers, "body": issue.body,
        })
    return result
