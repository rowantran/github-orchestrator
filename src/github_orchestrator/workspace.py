"""Git and Worktrunk operations on the configured checkout."""

from __future__ import annotations

import re
from pathlib import Path

from .config import Config
from .domain import OrchestratorError
from .process import CommandError, Commands


def github_remote_repo(url: str) -> str | None:
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?", url)
    return match[1].lower() if match else None


class Workspace:
    def __init__(self, config: Config, commands: Commands | None = None):
        self.config = config
        self.commands = commands or Commands()

    def git(self, *args: str, timeout: float = 60) -> str:
        return self.commands.run([self.config.executable("git"), *args],
                                 cwd=self.config.checkout, timeout=timeout).strip()

    def verify_checkout(self) -> None:
        root = Path(self.git("rev-parse", "--show-toplevel")).resolve()
        if root != self.config.checkout:
            raise OrchestratorError("checkout must name the repository root.")
        if github_remote_repo(self.git("remote", "get-url", "origin")) != self.config.repo.lower():
            raise OrchestratorError("The checkout's origin does not match the configured GitHub repository.")

    def branch_exists(self, branch: str) -> bool:
        try:
            self.git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}")
            return True
        except CommandError as exc:
            if exc.returncode == 1:
                return False
            raise

    def worktrees(self) -> dict[str, str]:
        """Branch name → worktree path, for every worktree of the checkout."""
        result, path = {}, None
        for line in self.git("worktree", "list", "--porcelain").splitlines():
            if line.startswith("worktree "):
                path = line.removeprefix("worktree ")
            elif line.startswith("branch refs/heads/") and path:
                result[line.removeprefix("branch refs/heads/")] = path
        return result

    def create(self, number: int, base: str | None = None) -> dict[str, str]:
        """Create the issue's branch and worktree from the latest base, or on top of `base` to stack."""
        branch = self.config.branch(number)
        existing = self.worktrees().get(branch)
        if existing or self.branch_exists(branch):
            where = f" at {existing}" if existing else " (no worktree)"
            raise OrchestratorError(f"Branch {branch} already exists{where}. Continue there, or remove it first.")
        if base is None:
            base = f"origin/{self.config.base_branch}"
            self.git("fetch", "origin", self.config.base_branch, timeout=300)
        try:
            commit = self.git("rev-parse", "--verify", f"{base}^{{commit}}")
        except CommandError as exc:
            raise OrchestratorError(f"Unknown base {base!r}; use a branch, tag or commit.") from exc
        self.commands.run([self.config.executable("wt"), "-C", str(self.config.checkout), "switch", "--create",
                           branch, "--base", commit, "--no-cd", "--format", "json"],
                          cwd=self.config.checkout, timeout=600)
        path = self.worktrees().get(branch)
        if not path:
            raise OrchestratorError(f"Worktrunk did not report a worktree for {branch}.")
        return {"issue": number, "branch": branch, "base": base, "base_commit": commit, "path": path}
