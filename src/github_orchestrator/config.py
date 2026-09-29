"""A single explicit queue per config file. Paths never depend on a worker's cwd."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .domain import OrchestratorError, validate_repo


def default_config_path() -> Path:
    return Path(os.environ.get("GHO_CONFIG", "~/.config/github-orchestrator/config.toml")).expanduser()


def asset_root() -> Path:
    installed = Path(__file__).parent / "agent-context"
    return installed if installed.is_dir() else Path(__file__).resolve().parents[2] / "agent-context"


def extension_path() -> Path:
    installed = Path(__file__).parent / "pi" / "worker.ts"
    return installed if installed.is_file() else Path(__file__).resolve().parents[2] / "pi" / "worker.ts"


@dataclass(frozen=True)
class Config:
    repo: str
    owner: str
    project_id: str
    project_url: str
    checkout: Path
    state_dir: Path
    workspace_dir: Path
    model: str
    provider_extension: Path
    isara_checkout: Path
    base_branch: str = "main"
    max_workers: int = 2
    timeout_seconds: int = 3600
    thinking: str = "high"
    context_files: tuple[str, ...] = ()
    vault: Path | None = None
    # Executable overrides make subprocess integration tests possible without an API/model.
    executables: dict[str, str] = field(default_factory=dict)

    @property
    def clone(self) -> Path:
        return self.workspace_dir / "repository"

    @property
    def tasks_dir(self) -> Path:
        return self.workspace_dir / "tasks"

    def executable(self, name: str) -> str:
        return self.executables.get(name, name)

    def validate(self) -> None:
        for name in ("repo", "owner", "project_id", "project_url", "model", "base_branch", "thinking"):
            if not isinstance(getattr(self, name), str):
                raise OrchestratorError(f"{name} must be a string.")
        validate_repo(self.repo)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", self.owner):
            raise OrchestratorError("owner must be a GitHub login.")
        if not self.project_id.startswith("PVT_"):
            raise OrchestratorError("project_id must be a GitHub Projects v2 ID (PVT_…). Run gho init.")
        if not re.fullmatch(r"https://github\.com/(?:users|orgs)/[A-Za-z0-9-]+/projects/[1-9][0-9]*/?", self.project_url):
            raise OrchestratorError("project_url must be a github.com user or organization Project URL.")
        if not self.model or self.model.startswith("-"):
            raise OrchestratorError("Set an explicit Isara model ID; no implicit model selection.")
        if (type(self.max_workers) is not int or type(self.timeout_seconds) is not int
                or not 1 <= self.max_workers <= 8 or self.timeout_seconds < 1):
            raise OrchestratorError("max_workers must be 1–8 and timeout_seconds must be positive.")
        if self.thinking not in {"off", "minimal", "low", "medium", "high", "xhigh", "max"}:
            raise OrchestratorError("Unknown thinking level.")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", self.base_branch) or ".." in self.base_branch:
            raise OrchestratorError("Invalid base branch.")
        home = Path.home().resolve()
        for name, path in (("state_dir", self.state_dir), ("workspace_dir", self.workspace_dir)):
            if path == home or not path.is_relative_to(home):
                raise OrchestratorError(f"{name} must be a dedicated directory under your home (Isara policy discovery).")
            if path == self.checkout or path.is_relative_to(self.checkout) or self.checkout.is_relative_to(path):
                raise OrchestratorError(f"{name} must be separate from your normal checkout.")
        if self.state_dir.is_relative_to(self.workspace_dir) or self.workspace_dir.is_relative_to(self.state_dir):
            raise OrchestratorError("State and workspace directories must not contain each other.")
        if self.vault and any(p.is_relative_to(self.vault) or self.vault.is_relative_to(p)
                              for p in (self.state_dir, self.workspace_dir)):
            raise OrchestratorError("Keep the Obsidian vault separate from runner state and workspaces.")
        if (not isinstance(self.context_files, (tuple, list))
                or any(not isinstance(path, str) for path in self.context_files)):
            raise OrchestratorError("context_files must be a list of path strings.")
        if len(set(self.context_files)) != len(self.context_files):
            raise OrchestratorError("context_files must not contain duplicate paths.")
        for path in self.context_files:
            if Path(path).is_absolute() or ".." in Path(path).parts or path in {"", "."}:
                raise OrchestratorError("context_files must be relative paths without '..'.")


def load_config(path: Path | None = None) -> Config:
    path = path or default_config_path()
    try:
        data = tomllib.loads(path.read_text())
        queue, worker = data["queue"], data["worker"]
        if any(not isinstance(section, dict) for section in (queue, worker, data.get("obsidian", {}))):
            raise OrchestratorError("queue, worker and obsidian must be TOML tables.")
        files = worker.get("context_files", [])
        if not isinstance(files, list) or any(not isinstance(item, str) for item in files):
            raise OrchestratorError("context_files must be a list of path strings.")
        def p(value: str) -> Path:
            return Path(value).expanduser().resolve()
        config = Config(
            repo=queue["repo"], owner=queue["owner"], project_id=queue["project_id"],
            project_url=queue["project_url"], checkout=p(queue["checkout"]),
            state_dir=p(queue["state_dir"]), workspace_dir=p(queue["workspace_dir"]),
            base_branch=queue.get("base_branch", "main"), model=worker["model"],
            provider_extension=p(worker["provider_extension"]), isara_checkout=p(worker["isara_checkout"]),
            max_workers=worker.get("max_workers", 2), timeout_seconds=worker.get("timeout_seconds", 3600),
            thinking=worker.get("thinking", "high"), context_files=tuple(files),
            vault=p(data["obsidian"]["vault"]) if data.get("obsidian", {}).get("vault") else None,
        )
        config.validate()
        return config
    except FileNotFoundError as exc:
        raise OrchestratorError(f"Config not found: {path}. Start with gho init --help.") from exc
    except (KeyError, TypeError, ValueError, tomllib.TOMLDecodeError) as exc:
        raise OrchestratorError(f"Invalid config {path}: {exc}") from exc
