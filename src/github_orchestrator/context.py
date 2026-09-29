"""Reviewable context assembly: file resources + explicit data, no embedded instructions."""

from __future__ import annotations

import ast
import hashlib
import json
import re
from pathlib import Path

from .config import Config, asset_root, extension_path
from .domain import Issue, OrchestratorError, digest
from .sandbox import Sandbox
from .workspace import Workspace

_TOKEN = re.compile(r"\{\{([a-z_]+)\}\}")
_HEADER = re.compile(r"\A\s*<!--.*?-->\s*", re.DOTALL)
MAX_CONTEXT_BYTES = 128 * 1024


def text_resource(name: str) -> str:
    path = asset_root() / name
    text = path.read_text()
    if not text.lstrip().startswith("<!-- Purpose:"):
        raise OrchestratorError(f"Agent resource needs a purpose/audience/injection header: {path}")
    return _HEADER.sub("", text, count=1)


def json_resource(name: str) -> dict:
    path = asset_root() / name
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or not value.get("_purpose"):
        raise OrchestratorError(f"Agent resource needs a top-level _purpose: {path}")
    return {key: val for key, val in value.items() if key != "_purpose"}


def render(template: str, values: dict[str, str]) -> str:
    missing = set(_TOKEN.findall(template)) - values.keys()
    if missing:
        raise OrchestratorError(f"Unknown context placeholders: {', '.join(sorted(missing))}")
    # A single regex pass: issue text that looks like a template remains literal task data.
    return _TOKEN.sub(lambda match: values[match[1]], template)


def bootstrap_prompt(checkout: Path) -> str:
    """Read Isara's versioned literal without importing code or fetching credentials."""
    path = checkout / "src/cli/agent_bootstrap_prompt.py"
    try:
        tree = ast.parse(path.read_text())
        versions = next(node.value for node in tree.body if isinstance(node, ast.AnnAssign)
                        and isinstance(node.target, ast.Name) and node.target.id == "AGENT_BOOTSTRAP_PROMPT_VERSIONS")
        assert isinstance(versions, ast.Tuple)
        last = versions.elts[-1]
        assert isinstance(last, ast.Call)
        prompt = ast.literal_eval(next(kw.value for kw in last.keywords if kw.arg == "prompt"))
        assert isinstance(prompt, str) and prompt.strip()
        return prompt
    except (OSError, SyntaxError, StopIteration, AssertionError, ValueError) as exc:
        raise OrchestratorError(f"Cannot statically inspect Isara's bootstrap prompt: {path}. Review launcher changes.") from exc


def hashes(root: Path, pattern: str) -> dict[str, str]:
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.glob(pattern)) if path.is_file() and "node_modules" not in path.parts}


class ContextBuilder:
    def __init__(self, config: Config, workspace: Workspace):
        self.config, self.workspace = config, workspace

    def snapshot(self, issue: Issue, base: str) -> dict:
        c = self.config
        files = [{"path": path, "content": self.workspace.source(base, path)} for path in c.context_files]
        snapshot = {
            "schema": 1, "issue": issue.plan(),
            "worker": {"model": c.model, "thinking": c.thinking, "timeout_seconds": c.timeout_seconds,
                       "provider_extension": str(c.provider_extension), "profile": "locked", "pi_version": "0.87.1"},
            "context_files": files,
            "expected_bootstrap": bootstrap_prompt(c.isara_checkout),
            "resource_hashes": hashes(asset_root(), "**/*"),
            "extension_hashes": hashes(extension_path().parent, "*.ts"),
            "provider_hashes": {**hashes(c.provider_extension.parent, "*.ts"),
                                **hashes(c.provider_extension.parent, "*.json")},
            "queue": {"repo": c.repo, "owner": c.owner, "project_id": c.project_id, "base_branch": c.base_branch},
            "sandbox_override": Sandbox(c).policy(),
        }
        if len(json.dumps(snapshot, ensure_ascii=False).encode()) > MAX_CONTEXT_BYTES:
            raise OrchestratorError("Approved task/context exceeds 128 KiB. Reduce explicit context; nothing was truncated.")
        return snapshot

    def bundle(self, snapshot: dict, *, run_id: str, branch: str, base_commit: str) -> dict[str, str]:
        issue = snapshot["issue"]
        context = {
            "schema": 1, "run_id": run_id, "issue": {key: issue[key] for key in ("url", "title", "body")},
            "base_commit": base_commit, "branch": branch, "context_files": snapshot["context_files"],
            "expected_bootstrap": snapshot["expected_bootstrap"],
        }
        values = {
            "run_id": run_id, "issue_url": issue["url"], "issue_title": issue["title"], "issue_body": issue["body"],
            "base_commit": base_commit, "branch": branch,
            "context_files": "\n\n".join(f"### {f['path']}\n\n{f['content']}" for f in snapshot["context_files"]),
            "result_schema": json.dumps(json_resource("result.schema.json"), indent=2, ensure_ascii=False),
        }
        bundle = {
            "system.md": render(text_resource("worker-system.md"), values),
            "append.md": render(text_resource("worker-append.md"), values),
            "task.md": render(text_resource("worker-task.md"), values),
            "context.json": json.dumps(context, indent=2, ensure_ascii=False) + "\n",
            "approval.json": json.dumps({"fingerprint": digest(snapshot), "snapshot": snapshot}, indent=2,
                                        ensure_ascii=False) + "\n",
            "isara-bootstrap.txt": snapshot["expected_bootstrap"] + "\n",
            "tool-definitions.json": json.dumps(json_resource("tool-definitions.json"), indent=2,
                                                ensure_ascii=False) + "\n",
        }
        # Freeze authored tool definitions and executable extension code per attempt.
        # A maintainer editing this checkout must not change an already approved worker's inputs.
        for path in sorted(extension_path().parent.glob("*.ts")):
            if path.is_file() and not path.name.endswith(".test.ts"):
                bundle[f"pi/{path.name}"] = path.read_text()
        for path in sorted(asset_root().glob("*.json")):
            bundle[f"agent-context/{path.name}"] = path.read_text()
        return bundle

    def write_bundle(self, directory: Path, bundle: dict[str, str]) -> None:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink():
            raise OrchestratorError("Context directory cannot be a symlink.")
        for name, content in bundle.items():
            target = directory / name
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise OrchestratorError("Invalid context bundle path.")
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() or target.is_symlink():
                raise OrchestratorError(f"Refusing to replace an existing context input: {target}")
            with target.open("x") as handle:
                handle.write(content)
            target.chmod(0o600)
