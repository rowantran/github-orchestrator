"""Optional, local-only Obsidian bridge. Completion never edits note frontmatter."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Iterator

import yaml

from .domain import IssueRef, OrchestratorError, digest

BRIDGE = ".github-orchestrator"
SCHEMA = 1
COMPLETION_MAX_AGE_SECONDS = 24 * 60 * 60
_RECEIPT_STATUSES = {
    "processing", "local-accepted", "already-done", "api-unavailable",
    "stale", "failed", "rolled-back", "interrupted",
}
_ID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
_NOTION_ID = re.compile(r"^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _note_path(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or any(c in value for c in "\\:\x00\r\n")
        or any(p in {"", ".", ".."} or p.startswith(".") for p in value.split("/"))
        or PurePosixPath(value).suffix.lower() != ".md"
    ):
        raise OrchestratorError("Use a vault-relative task Markdown path without traversal or hidden folders.")
    return value


def _urls(values: list[str]) -> list[str]:
    if not isinstance(values, list) or not values or not all(isinstance(v, str) for v in values):
        raise OrchestratorError("A note link requires at least one GitHub issue URL.")
    return sorted({IssueRef.parse(v).url.lower() for v in values})


def _notion_id(value: object) -> str:
    if not isinstance(value, str) or not _NOTION_ID.fullmatch(value):
        raise OrchestratorError("Task note has an invalid notion_page_id.")
    return str(uuid.UUID(value))


class Notes:
    """File bridge; the caller must verify all GitHub issues before requesting completion."""

    def __init__(self, vault: Path):
        self.vault = Path(vault).resolve()
        if not self.vault.is_dir():
            raise OrchestratorError("Obsidian vault must be an existing directory.")
        self.bridge = self.vault / BRIDGE

    def _safe(self, path: Path) -> Path:
        """Reject symlinks, including bridge paths, before any read or write."""
        try:
            relative = path.relative_to(self.vault)
            current = self.vault
            for part in relative.parts:
                current /= part
                if current.is_symlink():
                    raise OrchestratorError(f"Refusing symlink in vault path: {relative}")
            path.resolve().relative_to(self.vault)
        except ValueError as exc:
            raise OrchestratorError("Path escapes the Obsidian vault.") from exc
        return path

    def _mkdir(self, path: Path) -> None:
        self._safe(path).mkdir(parents=True, exist_ok=True)
        self._safe(path)

    @contextmanager
    def _lock(self) -> Iterator[None]:
        self._mkdir(self.bridge)
        lock = self._safe(self.bridge / "lock")
        deadline = time.monotonic() + 3
        while True:
            try:
                lock.mkdir()
                break
            except FileExistsError:
                self._safe(lock)
                if time.monotonic() >= deadline:
                    raise OrchestratorError(
                        "Obsidian bridge is locked. Retry; if a process crashed, stop bridge users "
                        "before removing .github-orchestrator/lock."
                    ) from None
                time.sleep(0.025)
        try:
            yield
        finally:
            lock.rmdir()

    def _read_json(self, path: Path) -> object:
        try:
            with self._safe(path).open(encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError) as exc:
            raise OrchestratorError(f"Cannot read bridge JSON: {path.name}: {exc}") from exc

    def _write_json(self, path: Path, value: object) -> None:
        self._safe(path)
        self._mkdir(path.parent)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
        try:
            with temporary.open("x", encoding="utf-8", newline="\n") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            self._safe(path)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _registry(self) -> list[dict]:
        path = self._safe(self.bridge / "links.json")
        if not path.exists():
            return []
        data = self._read_json(path)
        if not isinstance(data, dict) or data.get("schemaVersion") != SCHEMA or not isinstance(data.get("links"), list):
            raise OrchestratorError("Invalid links.json schema; repair it before updating associations.")
        ids: set[str] = set()
        paths: set[str] = set()
        notion_ids: set[str] = set()
        for link in data["links"]:
            if not isinstance(link, dict) or not isinstance(link.get("id"), str) or not _ID.fullmatch(link["id"]):
                raise OrchestratorError("Invalid link ID in links.json.")
            path_value = _note_path(link.get("notePath"))
            self._safe(self.vault / path_value)
            if link.get("issueUrls") != _urls(link.get("issueUrls")):
                raise OrchestratorError("Issue URLs in links.json must be canonical, unique, and sorted.")
            if link["id"] in ids or path_value in paths:
                raise OrchestratorError("Duplicate link identity in links.json.")
            ids.add(link["id"])
            paths.add(path_value)
            if "notionPageId" in link:
                notion_id = _notion_id(link["notionPageId"])
                if notion_id != link["notionPageId"] or notion_id in notion_ids:
                    raise OrchestratorError("Duplicate or noncanonical Notion identity in links.json.")
                notion_ids.add(notion_id)
        return data["links"]

    def _metadata(self, note_path: str) -> dict:
        path = self._safe(self.vault / _note_path(note_path))
        try:
            with path.open(encoding="utf-8-sig") as handle:
                if handle.readline().strip() != "---":
                    raise OrchestratorError("Task note must have YAML frontmatter with type: task.")
                lines: list[str] = []
                size = 0
                for line in handle:
                    if line.strip() == "---":
                        break
                    size += len(line)
                    if size > 131072:
                        raise OrchestratorError("Task frontmatter exceeds the bridge size limit.")
                    lines.append(line)
                else:
                    raise OrchestratorError("Task note has unterminated YAML frontmatter.")
            text = "".join(lines)
            # Aliases are unnecessary here and can expand unexpectedly.
            if any(isinstance(event, yaml.AliasEvent) for event in yaml.parse(text)):
                raise OrchestratorError("Task frontmatter aliases are not supported by the bridge.")
            value = yaml.safe_load(text)
        except (OSError, UnicodeError, yaml.YAMLError) as exc:
            raise OrchestratorError(f"Cannot read task frontmatter: {note_path}: {exc}") from exc
        if not isinstance(value, dict) or value.get("type") != "task":
            raise OrchestratorError("Only notes with type: task can be linked.")
        if value.get("notion_managed") is True and "notion_page_id" not in value:
            raise OrchestratorError("Managed Notion task is missing notion_page_id.")
        return value

    def links(self) -> list[dict]:
        """Return canonical associations; do not read note bodies or change note files."""
        with self._lock():
            return sorted(self._registry(), key=lambda link: link["id"])

    def link(self, note_path: str, issue_urls: list[str]) -> dict:
        """Replace this note's issue set, preserving its stable association ID."""
        return self._update_link(note_path, issue_urls, union=False)

    def add(self, note_path: str, issue_urls: list[str]) -> dict:
        """Atomically union issues with this note's existing canonical association."""
        return self._update_link(note_path, issue_urls, union=True)

    def _update_link(self, note_path: str, issue_urls: list[str], *, union: bool) -> dict:
        note_path = _note_path(note_path)
        urls = _urls(issue_urls)
        with self._lock():
            metadata = self._metadata(note_path)
            notion_id = _notion_id(metadata["notion_page_id"]) if "notion_page_id" in metadata else None
            links = self._registry()
            matching = [
                item for item in links
                if item["notePath"] == note_path or (notion_id and item.get("notionPageId") == notion_id)
            ]
            if len(matching) > 1:
                raise OrchestratorError("Conflicting path and Notion identities in links.json.")
            previous = matching[0] if matching else None
            if previous and previous.get("notionPageId") != notion_id:
                raise OrchestratorError("Task identity changed at this path; resolve the old association first.")
            if union and previous:
                urls = sorted(set(previous["issueUrls"]) | set(urls))
            result = {"id": previous["id"] if previous else str(uuid.uuid4()), "notePath": note_path, "issueUrls": urls}
            if notion_id:
                result["notionPageId"] = notion_id
            links = [item for item in links if item is not previous] + [result]
            self._write_json(self.bridge / "links.json", {"schemaVersion": SCHEMA, "links": sorted(links, key=lambda x: x["id"])})
            return result

    def _current(self, link: dict) -> dict:
        """Validate a caller's snapshot while holding the shared lock."""
        if not isinstance(link, dict):
            raise OrchestratorError("Completion requires a current note association.")
        current = next((item for item in self._registry() if item["id"] == link.get("id")), None)
        if current is None or current != link:
            raise OrchestratorError("Note association changed; reload links and recheck all GitHub issues.")
        return current

    def completion_state(self, link: dict) -> dict | None:
        """Latest exact-set request/receipt, for caller-controlled duplicate suppression."""
        with self._lock():
            current = self._current(link)
            fingerprint = digest(current["issueUrls"])
            directory = self._safe(self.bridge / "requests")
            if not directory.exists():
                return None
            candidates = []
            for path in directory.glob("*.json"):
                if not _ID.fullmatch(path.stem):
                    continue
                request = self._read_json(path)
                if not isinstance(request, dict):
                    raise OrchestratorError(f"Invalid completion request: {path.name}")
                if request.get("linkId") != current["id"] or request.get("issueFingerprint") != fingerprint:
                    continue
                if (request.get("schemaVersion") != SCHEMA or request.get("id") != path.stem
                        or request.get("issueUrls") != current["issueUrls"]):
                    raise OrchestratorError(f"Completion request identity mismatch: {path.name}")
                try:
                    requested_at = datetime.fromisoformat(request["requestedAt"])
                    if requested_at.tzinfo is None:
                        raise ValueError("Missing timezone")
                except (KeyError, TypeError, ValueError) as exc:
                    raise OrchestratorError(f"Invalid completion request timestamp: {path.name}") from exc
                candidates.append((requested_at, self._safe(path).stat().st_mtime_ns, path.stem, request))
            if not candidates:
                return None
            requested_at, _, _, request = max(candidates, key=lambda item: item[:3])
            path = self._safe(self.bridge / "receipts" / f"{request['id']}.json")
            has_receipt = path.exists()
            receipt = self._read_json(path) if has_receipt else None
            if has_receipt:
                if (not isinstance(receipt, dict) or receipt.get("schemaVersion") != SCHEMA
                        or receipt.get("requestId") != request["id"] or receipt.get("linkId") != current["id"]
                        or receipt.get("issueFingerprint") != fingerprint
                        or not isinstance(receipt.get("status"), str)
                        or receipt["status"] not in _RECEIPT_STATUSES):
                    raise OrchestratorError("Completion receipt identity or status mismatch; inspect it before retrying.")
                status = receipt["status"]
            else:
                age = (datetime.now(UTC) - requested_at).total_seconds()
                status = "stale" if age > COMPLETION_MAX_AGE_SECONDS else "pending"
            return {
                "status": status, "requestId": request["id"], "requestedAt": request["requestedAt"],
                "issueFingerprint": fingerprint, "receipt": receipt,
            }

    def request_completion(self, link: dict) -> dict:
        """Queue one explicit completion attempt, only after the caller verifies GitHub."""
        with self._lock():
            current = self._current(link)
            request = {
                "schemaVersion": SCHEMA,
                "id": str(uuid.uuid4()),
                "linkId": current["id"],
                "issueUrls": current["issueUrls"],
                "issueFingerprint": digest(current["issueUrls"]),
                "requestedAt": _now(),
            }
            self._write_json(self.bridge / "requests" / f"{request['id']}.json", request)
            return request
