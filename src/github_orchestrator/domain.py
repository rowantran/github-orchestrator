"""Small value types shared by adapters. No I/O and no agent instructions."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any


class OrchestratorError(Exception):
    """An actionable error suitable for the CLI (never silently treated as readiness)."""


_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_URL = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/issues/([1-9][0-9]*)$")


def validate_repo(value: str) -> str:
    if not _REPO.fullmatch(value) or any(part in {".", ".."} for part in value.split("/")):
        raise OrchestratorError("Repository must be OWNER/REPO on github.com.")
    return value


@dataclass(frozen=True, order=True)
class IssueRef:
    repo: str
    number: int

    def __post_init__(self) -> None:
        validate_repo(self.repo)
        if type(self.number) is not int or self.number < 1:
            raise OrchestratorError("Issue number must be a positive integer.")

    @property
    def url(self) -> str:
        return f"https://github.com/{self.repo.lower()}/issues/{self.number}"

    @property
    def key(self) -> str:
        return f"{self.repo.lower()}#{self.number}"

    @classmethod
    def parse(cls, value: str, repo: str | None = None) -> IssueRef:
        match = _URL.fullmatch(value.rstrip("/"))
        if match:
            return cls(match[1], int(match[2]))
        if repo and value.removeprefix("#").isdigit():
            return cls(repo, int(value.removeprefix("#")))
        raise OrchestratorError("Use an issue number or a full https://github.com/OWNER/REPO/issues/N URL.")


@dataclass(frozen=True)
class PullRequest:
    number: int
    url: str
    state: str
    merged: bool
    base: str
    head: str
    merge_commit: str | None = None
    repo: str = ""


@dataclass(frozen=True)
class Issue:
    ref: IssueRef
    title: str
    body: str
    state: str
    state_reason: str | None
    assignees: tuple[str, ...] = ()
    project_ids: tuple[str, ...] = ()
    blockers: tuple[IssueRef, ...] = ()
    pull_requests: tuple[PullRequest, ...] = ()
    updated_at: str = ""
    project_item_id: str | None = None

    @property
    def completed(self) -> bool:
        # Not-planned and duplicate closures do not mean successful delivery.
        return self.state.upper() == "CLOSED" and self.state_reason == "COMPLETED"

    def plan(self) -> dict[str, Any]:
        """Only fields that change the approved work, not comments or runtime status."""
        return {
            "url": self.ref.url,
            "title": self.title,
            "body": self.body,
            "blockers": sorted(ref.url for ref in self.blockers),
        }


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class Readiness:
    issue: Issue
    ready: bool
    reason: str
    fingerprint: str = ""
    prerequisites: tuple[PullRequest, ...] = ()


@dataclass
class Run:
    id: str
    issue_url: str
    fingerprint: str
    status: str
    branch: str
    worktree: str
    base_commit: str = ""
    pid: int | None = None
    started_at: str = ""
    updated_at: str = ""
    detail: str = ""
    pr_url: str | None = None
    commit: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)
