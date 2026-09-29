"""Host-side Git/Worktrunk lifecycle. Never run repository hooks or force cleanup."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .config import Config
from .domain import OrchestratorError, Run
from .process import CommandError, Commands


def github_remote_repo(url: str) -> str | None:
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?", url)
    return match[1].lower() if match else None


class Workspace:
    def __init__(self, config: Config, commands: Commands | None = None):
        self.config = config
        self.commands = commands or Commands()

    def git(self, *args: str, cwd: Path | None = None, timeout: float = 60) -> str:
        return self.commands.run([
            self.config.executable("git"), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            *args,
        ], cwd=cwd or self.config.clone, timeout=timeout).strip()

    def verify_checkout(self) -> None:
        root = Path(self.git("rev-parse", "--show-toplevel", cwd=self.config.checkout)).resolve()
        if root != self.config.checkout:
            raise OrchestratorError("checkout must name the repository root.")
        remote = self.git("remote", "get-url", "origin", cwd=self.config.checkout)
        if github_remote_repo(remote) != self.config.repo.lower():
            raise OrchestratorError("The checkout's origin does not match the configured GitHub repository.")

    def ensure_clone(self) -> None:
        c = self.config
        self.verify_checkout()
        c.workspace_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        c.tasks_dir.mkdir(exist_ok=True, mode=0o700)
        if not c.clone.exists():
            # Copy the Git database once. No alternates/hardlinks tying retention to the user's checkout.
            self.git("clone", "--no-checkout", "--no-hardlinks", "--", str(c.checkout), str(c.clone),
                     cwd=c.workspace_dir, timeout=600)
            self.git("remote", "set-url", "origin", f"https://github.com/{c.repo}.git")
            self.git("config", "core.hooksPath", "/dev/null")
            self.git("config", "core.fsmonitor", "false")
            exclude = c.clone / ".git/info/exclude"
            with exclude.open("a") as handle:
                handle.write("\n/.gho/\n/security_profile.json\n")
        elif self.git("remote", "get-url", "origin") != f"https://github.com/{c.repo}.git":
            raise OrchestratorError("Managed clone has an unexpected origin; refusing to use it.")
        if c.clone.is_symlink() or not (c.clone / ".git").is_dir():
            raise OrchestratorError("Managed clone must be a normal Git repository, not a symlink or bare repo.")

    def fetch(self) -> str:
        self.ensure_clone()
        self.git("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
                 "fetch", "--no-tags", "origin",
                 f"+refs/heads/{self.config.base_branch}:refs/remotes/origin/{self.config.base_branch}", timeout=300)
        return self.git("rev-parse", f"refs/remotes/origin/{self.config.base_branch}")

    def source(self, commit: str, path: str) -> str:
        # Git object reads cannot follow checkout symlinks or race local editor writes.
        entry = self.git("ls-tree", commit, "--", path)
        if not entry or entry.split()[0] not in {"100644", "100755"}:
            raise OrchestratorError(f"Context file is missing or is not a regular tracked file: {path}")
        return self.commands.run([self.config.executable("git"), "show", f"{commit}:{path}"], cwd=self.config.clone)

    def ancestor(self, commit: str, base: str) -> bool:
        try:
            self.git("merge-base", "--is-ancestor", commit, base)
            return True
        except CommandError as exc:
            if exc.returncode == 1:
                return False
            raise

    def _wt(self, args: list[str], path: Path | None = None) -> str:
        c = self.config
        env = dict(os.environ)
        # Disable Git hooks too; --no-hooks below only covers Worktrunk's hooks.
        for key in list(env):
            if key.startswith(("WORKTRUNK_", "GIT_CONFIG_")):
                env.pop(key)
        env.update({
            "WORKTRUNK_PROJECT_CONFIG_PATH": "/dev/null", "WORKTRUNK_CONFIG_PATH": "/dev/null",
            "GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null",
            "GIT_CONFIG_KEY_1": "core.fsmonitor", "GIT_CONFIG_VALUE_1": "false",
        })
        command = [c.executable("wt"), "-C", str(c.clone), "--config", "/dev/null"]
        if path:
            command += ["--config-set", f"worktree-path = {json.dumps(str(path))}"]
        return self.commands.run([*command, *args], cwd=c.clone, env=env, timeout=300)

    def create(self, run: Run) -> None:
        path = Path(run.worktree)
        if path.parent != self.config.tasks_dir or path.exists() or path.is_symlink():
            raise OrchestratorError("New worktree must be an unused direct child of the configured tasks directory.")
        if self.git("ls-tree", "--name-only", run.base_commit, "--", ".gho"):
            raise OrchestratorError("The repository tracks reserved path .gho; choose a different runner layout.")
        self._wt(["switch", "--create", run.branch, "--base", run.base_commit,
                  "--no-hooks", "--no-cd", "--format", "json"], path=path)
        self.verify(run)
        if self.git("rev-parse", "HEAD", cwd=path) != run.base_commit:
            raise OrchestratorError("Worktrunk did not create the expected base commit.")

    def verify(self, run: Run) -> None:
        path = Path(run.worktree)
        if path.parent != self.config.tasks_dir or path.is_symlink() or not path.is_dir():
            raise OrchestratorError("Worktree path no longer matches this runner's managed directory.")
        common = Path(self.git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=path)).resolve()
        if common != (self.config.clone / ".git").resolve():
            raise OrchestratorError("Worktree Git metadata no longer belongs to the managed clone.")
        if self.git("branch", "--show-current", cwd=path) != run.branch:
            raise OrchestratorError("Worker changed the branch; refusing publication or cleanup.")

    def changed_files(self, run: Run) -> list[str]:
        self.verify(run)
        path = Path(run.worktree)
        tracked = self.commands.run([self.config.executable("git"), "-c", "core.fsmonitor=false",
                                    "diff", "--name-only", "-z", run.base_commit, "--"], cwd=path)
        untracked = self.commands.run([self.config.executable("git"), "ls-files", "--others",
                                      "--exclude-standard", "-z"], cwd=path)
        return sorted({p for p in (tracked + untracked).split("\0") if p and not p.startswith(".gho/")})

    def commit(self, run: Run, title: str) -> str:
        self.verify(run)
        path = Path(run.worktree)
        head = self.git("rev-parse", "HEAD", cwd=path)
        # Supports retrying a publish after the commit succeeded but the push/API failed.
        if run.commit and head == run.commit:
            if self.git("status", "--porcelain", cwd=path):
                raise OrchestratorError("Worktree changed after its recorded publication commit; review it first.")
            return head
        if head != run.base_commit:
            raise OrchestratorError("Unexpected commits in worker branch; workers must not commit or rewrite history.")
        changed = self.changed_files(run)
        if not changed:
            raise OrchestratorError("No code changes to publish.")
        if len(changed) > 1000:
            raise OrchestratorError("More than 1000 changed paths; split or review this task manually before publication.")
        # Git identity comes from the operator, never from the worker.
        name = self.git("config", "user.name", cwd=self.config.checkout)
        email = self.git("config", "user.email", cwd=self.config.checkout)
        self.git("--literal-pathspecs", "add", "-A", "--", *changed, cwd=path)
        self.git("-c", f"user.name={name}", "-c", f"user.email={email}", "-c", "commit.gpgsign=false",
                 "commit", "-m", title, cwd=path)
        return self.git("rev-parse", "HEAD", cwd=path)

    def push(self, run: Run) -> None:
        self.verify(run)
        self.git("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
                 "push", "--set-upstream", "origin", f"HEAD:refs/heads/{run.branch}",
                 cwd=Path(run.worktree), timeout=300)

    def cleanup(self, run: Run) -> None:
        if run.status != "merged":
            raise OrchestratorError("Cleanup only accepts verified merged runs. Failed work is kept.")
        self.verify(run)
        self._wt(["remove", run.branch, "--foreground", "--no-delete-branch", "--no-hooks", "--format", "json"])
