"""One queue per config file: which GitHub issues are yours, and which checkout gets the worktrees."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .domain import OrchestratorError, validate_repo


def default_config_path() -> Path:
    return Path(os.environ.get("GHO_CONFIG", "~/.config/github-orchestrator/config.toml")).expanduser()


@dataclass(frozen=True)
class Config:
    repo: str
    owner: str
    project_id: str
    project_url: str
    checkout: Path
    base_branch: str = "main"
    vault: Path | None = None
    # Executable overrides make subprocess integration tests possible.
    executables: dict[str, str] = field(default_factory=dict)

    def executable(self, name: str) -> str:
        return self.executables.get(name, name)

    def branch(self, number: int) -> str:
        """The one branch name gho uses for an issue; also how `ready` spots work in progress."""
        return f"{self.owner}/gh-{number}"

    def validate(self) -> None:
        for name in ("repo", "owner", "project_id", "project_url", "base_branch"):
            if not isinstance(getattr(self, name), str):
                raise OrchestratorError(f"{name} must be a string.")
        validate_repo(self.repo)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", self.owner):
            raise OrchestratorError("owner must be a GitHub login.")
        if not self.project_id.startswith("PVT_"):
            raise OrchestratorError("project_id must be a GitHub Projects v2 ID (PVT_…). Run gho init.")
        if not re.fullmatch(r"https://github\.com/(?:users|orgs)/[A-Za-z0-9-]+/projects/[1-9][0-9]*/?", self.project_url):
            raise OrchestratorError("project_url must be a github.com user or organization Project URL.")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", self.base_branch) or ".." in self.base_branch:
            raise OrchestratorError("Invalid base branch.")


def load_config(path: Path | None = None) -> Config:
    path = path or default_config_path()
    try:
        data = tomllib.loads(path.read_text())
        queue, obsidian = data["queue"], data.get("obsidian", {})
        if not isinstance(queue, dict) or not isinstance(obsidian, dict):
            raise OrchestratorError("queue and obsidian must be TOML tables.")
        config = Config(
            repo=queue["repo"], owner=queue["owner"], project_id=queue["project_id"],
            project_url=queue["project_url"], checkout=Path(queue["checkout"]).expanduser().resolve(),
            base_branch=queue.get("base_branch", "main"),
            vault=Path(obsidian["vault"]).expanduser().resolve() if obsidian.get("vault") else None,
        )
        config.validate()
        return config
    except FileNotFoundError as exc:
        raise OrchestratorError(f"Config not found: {path}. Start with gho init --help.") from exc
    except (KeyError, TypeError, ValueError, tomllib.TOMLDecodeError) as exc:
        raise OrchestratorError(f"Invalid config {path}: {exc}") from exc
