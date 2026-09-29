"""The orchestration policy. Adapters perform I/O; this module decides what is allowed."""

from __future__ import annotations

import json
import os
import signal
import stat
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .config import Config
from .context import ContextBuilder, digest
from .domain import Issue, IssueRef, OrchestratorError, Readiness, Run
from .github import GitHub
from .sandbox import Sandbox
from .state import Store, process_group_alive
from .workspace import Workspace


def read_regular(path: Path, root: Path, limit: int = 1_048_576) -> str:
    if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
        raise OrchestratorError(f"Unsafe worker output path: {path}")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise OrchestratorError(f"Worker output must be a regular file under {limit} bytes: {path}")
    return path.read_text()


def validate_result(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"status", "summary", "tests", "blockers"}:
        raise OrchestratorError("Worker result has missing or unexpected fields.")
    if value["status"] not in {"ready_for_review", "blocked"}:
        raise OrchestratorError("Worker result has an invalid status.")
    if not isinstance(value["summary"], str) or not value["summary"].strip():
        raise OrchestratorError("Worker result needs a nonempty summary.")
    for key in ("tests", "blockers"):
        if not isinstance(value[key], list) or any(not isinstance(s, str) or not s.strip() for s in value[key]):
            raise OrchestratorError(f"Worker result {key} must contain nonempty strings.")
    if bool(value["blockers"]) != (value["status"] == "blocked"):
        raise OrchestratorError("Worker result status conflicts with its blockers.")
    return value


def check_audit(raw: str, run: Run, inputs: Path) -> None:
    """Cross-check writable audit evidence against the host's frozen input copy."""
    audit = json.loads(raw)
    manifest = json.loads((inputs / "context.json").read_text())
    if (not isinstance(audit, dict) or type(audit.get("schema")) is not int
            or any(audit.get(key) != value for key, value in manifest.items())):
        raise OrchestratorError("Worker context audit does not match the approved input manifest.")
    if audit.get("cwd") != run.worktree or audit.get("context_path") != str(Path(run.worktree) / ".gho/input/context.json"):
        raise OrchestratorError("Worker context audit names a different worktree.")
    system, task = audit.get("system_prompt"), audit.get("task_prompt")
    expected_system = [(inputs / name).read_text() for name in ("system.md", "append.md")]
    expected_system.append(manifest["expected_bootstrap"])
    if (not isinstance(system, str) or any(part not in system for part in expected_system)
            or not isinstance(task, str) or (inputs / "task.md").read_text() not in task):
        raise OrchestratorError("Worker audit is missing approved prompt content.")
    definitions = json.loads((inputs / "tool-definitions.json").read_text())["tools"]
    expected_tools = [{key: value for key, value in tool.items() if key != "label"}
                      for tool in definitions.values()]
    actual_tools = audit.get("tools")
    if (not isinstance(actual_tools, list) or any(not isinstance(t, dict) for t in actual_tools)
            or sorted(actual_tools, key=lambda t: str(t.get("name"))) != sorted(expected_tools, key=lambda t: t["name"])):
        raise OrchestratorError("Worker audit tool definitions do not match the approved definitions.")


def check_events(path: Path, expected_cwd: Path) -> None:
    header = settled = False
    last_assistant = None
    try:
        with path.open(encoding="utf-8", newline="\n") as handle:
            for line in handle:
                if not line.strip():
                    continue
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError("event is not an object")
                if event.get("type") == "session":
                    if Path(event.get("cwd", "")).resolve() != expected_cwd.resolve():
                        raise OrchestratorError("Pi session cwd does not match the task worktree.")
                    header = True
                if event.get("type") == "agent_start":
                    settled = False
                    last_assistant = None
                if event.get("type") == "agent_settled":
                    settled = True
                if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
                    last_assistant = event["message"]
    except (ValueError, UnicodeError) as exc:
        raise OrchestratorError("Pi stdout was not a complete JSON event stream. See events.jsonl and stderr.log.") from exc
    if not header or not settled or not last_assistant or last_assistant.get("stopReason") != "stop":
        raise OrchestratorError("Pi did not finish a successful, settled assistant turn; exit code alone is insufficient.")


class Runner:
    def __init__(self, config: Config, *, github=None, workspace=None, sandbox=None, store=None):
        self.config = config
        self.github = github or GitHub(config.repo, config.project_id, config.owner)
        self.workspace = workspace or Workspace(config)
        self.sandbox = sandbox or Sandbox(config)
        self.store = store or Store(config.state_dir)
        self.context = ContextBuilder(config, self.workspace)
        self.stop = threading.Event()
        self._thread_lock = threading.Lock()
        self.warnings: list[str] = []

    def owned(self, issue: Issue) -> bool:
        return (issue.ref.repo.lower() == self.config.repo.lower()
                and self.config.owner.lower() in {name.lower() for name in issue.assignees}
                and self.config.project_id in issue.project_ids)

    def require_owned(self, issue: Issue, *, open_only: bool = True) -> None:
        if not self.owned(issue) or (open_only and issue.state != "OPEN"):
            raise OrchestratorError("Issue is not an open task assigned to you in the configured repository and Project.")

    def require_completed(self, issue: Issue, base: str) -> tuple:
        """One completion rule for dependencies and TaskNotes requests, not mere closure."""
        ref = issue.ref
        if not issue.completed:
            raise OrchestratorError(f"Blocked by {ref.key}: not successfully completed.")
        prs = [pr for pr in issue.pull_requests if pr.merged]
        if ref.repo.lower() == self.config.repo.lower():
            prs = [pr for pr in prs if pr.repo.lower() == self.config.repo.lower()
                   and pr.base == self.config.base_branch and pr.merge_commit
                   and self.workspace.ancestor(pr.merge_commit, base)]
        if not prs and self.store.acknowledgment(ref.url) != digest(issue.plan()):
            raise OrchestratorError(f"Blocked by {ref.key}: no verified integrated PR; acknowledge only if this is non-code work.")
        return tuple(prs)

    def prerequisites(self, issue: Issue, base: str) -> tuple:
        result = []
        for ref in issue.blockers:
            if ref.key == issue.ref.key:
                raise OrchestratorError("Issue depends on itself.")
            result.extend(self.require_completed(self.github.issue(ref), base))
        return tuple(result)

    def readiness(self, issue: Issue, base: str) -> Readiness:
        try:
            self.require_owned(issue)
            last = self.store.latest(issue.ref.url)
            if last and last.status != "superseded":
                return Readiness(issue, False, f"{last.status}: {last.id}")
            snapshot = self.context.snapshot(issue, base)
            fingerprint = digest(snapshot)
            approval = self.store.approval(issue.ref.url)
            if not approval:
                return Readiness(issue, False, "needs approval", fingerprint)
            if approval["fingerprint"] != fingerprint:
                return Readiness(issue, False, "plan/context changed; approve again", fingerprint)
            prerequisites = self.prerequisites(issue, base)
            return Readiness(issue, True, "ready", fingerprint, prerequisites)
        except OrchestratorError as exc:
            return Readiness(issue, False, str(exc))

    def status(self, *, fetch: bool = True) -> list[Readiness]:
        base = self.workspace.fetch() if fetch else self.workspace.git("rev-parse", f"origin/{self.config.base_branch}")
        return [self.readiness(issue, base) for issue in self.github.queue()]

    def approve(self, ref: IssueRef, expected: str | None = None) -> str:
        with self.store.lock():
            base = self.workspace.fetch()
            issue = self.github.issue(ref)
            self.require_owned(issue)
            snapshot = self.context.snapshot(issue, base)
            fingerprint = digest(snapshot)
            if expected is not None and expected != fingerprint:
                raise OrchestratorError("Task changed since preview; inspect it again before approving.")
            self.store.approve(ref.url, fingerprint, snapshot)
            self.mirror_status(ref, "Approved")
            return fingerprint

    def mirror_status(self, ref: IssueRef, status: str) -> str | None:
        # Projection only: API/status-field failures must never erase local run state.
        warning = None
        try:
            if not self.github.set_project_status(ref, status):
                warning = f"Project has no exact Status option {status!r}; local state is retained."
        except OrchestratorError as exc:
            warning = f"Could not mirror project status: {exc}"
        if warning:
            self.warnings.append(warning)
        return warning

    def run_ready(self, *, issue_number: int | None = None, dry_run: bool = False) -> list[Run] | list[Readiness]:
        with self.store.lock():
            candidates = self.status()
            if issue_number is not None:
                candidates = [item for item in candidates if item.issue.ref.number == issue_number]
                if not candidates:
                    raise OrchestratorError("That issue is not in your open queue.")
            if dry_run:
                return candidates
            self.sandbox.prerequisites()
            # A surviving worker from an interrupted dispatcher still consumes capacity.
            uncertain = [run for run in self.store.runs() if run.status in {"preparing", "running"}]
            if uncertain:
                raise OrchestratorError("Unreconciled preparing/running attempts exist. Run gho recover before dispatch.")
            results: list[Run] = []
            ready = [item for item in candidates if item.ready]
            self.stop.clear()
            with ThreadPoolExecutor(max_workers=self.config.max_workers) as pool:
                futures = [pool.submit(self.execute, item.issue.ref) for item in ready]
                try:
                    for future in as_completed(futures):
                        results.append(future.result())
                except KeyboardInterrupt:
                    self.stop.set()
                    for future in futures:
                        future.cancel()
                    raise
            return results

    def execute(self, ref: IssueRef) -> Run:
        if self.stop.is_set():
            raise OrchestratorError("Dispatch interrupted.")
        # Worktrunk registry mutations and fresh Git fetches are serialized separately from agent execution.
        with self._workspace_lock():
            base = self.workspace.fetch()
            issue = self.github.issue(ref)
            ready = self.readiness(issue, base)
            if not ready.ready:
                raise OrchestratorError(f"{ref.key} is no longer ready: {ready.reason}")
            run_id = f"gh-{ref.number}-{uuid.uuid4().hex[:12]}"
            run = Run(run_id, ref.url, ready.fingerprint, "preparing",
                      f"{self.config.owner}/agents/{run_id}", str(self.config.tasks_dir / run_id), base)
            self.store.create(run)
            try:
                self.workspace.create(run)
                path = Path(run.worktree)
                snapshot = self.context.snapshot(issue, base)
                bundle = self.context.bundle(snapshot, run_id=run.id, branch=run.branch, base_commit=base)
                self.context.write_bundle(path / ".gho/input", bundle)
                log_dir = self.config.state_dir / "attempts" / run.id
                self.context.write_bundle(log_dir / "input", bundle)
                policy = self.sandbox.prepare(path)
                (log_dir / "sandbox.json").write_text(json.dumps(policy, indent=2))
                # Re-read after setup. Ownership, blockers and approved context can change while a clone is built.
                fresh = self.github.issue(ref)
                self.require_owned(fresh)
                if digest(self.context.snapshot(fresh, base)) != run.fingerprint:
                    raise OrchestratorError("Task or context changed during preparation; no worker launched.")
                approval = self.store.approval(ref.url)
                if not approval or approval["fingerprint"] != run.fingerprint:
                    raise OrchestratorError("Approval revoked during preparation; no worker launched.")
                self.prerequisites(fresh, base)
            except Exception as exc:
                return self.store.update(run.id, status="failed", detail=str(exc))
        warning = self.mirror_status(ref, "Running")
        try:
            if self.stop.is_set():
                raise OrchestratorError("Dispatch interrupted before worker launch.")
            approval = self.store.approval(ref.url)
            if not approval or approval["fingerprint"] != run.fingerprint:
                raise OrchestratorError("Approval revoked before worker launch.")
            result = self.launch(run)
            changed = self.workspace.changed_files(run)
            if self.workspace.git("rev-parse", "HEAD", cwd=Path(run.worktree)) != run.base_commit:
                raise OrchestratorError("Worker created commits despite the read-only Git policy.")
            status = "blocked" if result["status"] == "blocked" else "review"
            if status == "review" and not changed:
                raise OrchestratorError("Worker requested review but produced no code changes.")
            current = self.github.issue(ref)
            if not self.owned(current) or current.state != "OPEN" or digest(self.context.snapshot(current, run.base_commit)) != run.fingerprint:
                status = "blocked"
                result["status"] = "blocked"
                result["blockers"].append("Issue ownership, state or approved plan changed during execution.")
            updated = self.store.update(run.id, status=status, detail=result["summary"],
                                        metadata={"result": result, "changed_files": changed, "warning": warning})
            self.mirror_status(ref, "Review" if status == "review" else "Needs input")
            return updated
        except Exception as exc:
            status = "interrupted" if self.stop.is_set() else "failed"
            self.mirror_status(ref, "Needs input")
            return self.store.update(run.id, status=status, detail=str(exc))

    def _workspace_lock(self):
        # Threads in one dispatcher plus future adapters share this same OS-backed lock.
        # flock is deliberately nonblocking for processes; threads use an in-process mutex.
        return self._thread_lock

    def argv(self, run: Run) -> list[str]:
        c, path = self.config, Path(run.worktree)
        inputs = path / ".gho/input"
        return [c.executable("isara"), "pi", "run", "--profile", "locked", "--duration", f"{c.timeout_seconds}s", "--",
                "--mode", "json", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
                "--no-context-files", "--no-approve", "--no-builtin-tools",
                "--extension", str(c.provider_extension), "--extension", str(inputs / "pi/worker.ts"),
                "--provider", "isara", "--model", c.model, "--thinking", c.thinking,
                "--system-prompt", str(inputs / "system.md"), "--append-system-prompt", str(inputs / "append.md"),
                "--session-dir", str(path / ".gho/sessions"), "--session-id", run.id,
                "--gho-context", str(inputs / "context.json"), f"@{inputs / 'task.md'}"]

    def launch(self, run: Run) -> dict:
        path = Path(run.worktree)
        log = self.config.state_dir / "attempts" / run.id
        log.mkdir(parents=True, exist_ok=True)
        argv = self.argv(run)
        (log / "command.json").write_text(json.dumps(argv, indent=2))
        with (log / "events.jsonl").open("wb") as stdout, (log / "stderr.log").open("wb") as stderr:
            proc = subprocess.Popen(argv, cwd=path, env=self.sandbox.environment(path), stdin=subprocess.DEVNULL,
                                    stdout=stdout, stderr=stderr, start_new_session=True)
            start = time.monotonic()
            try:
                self.store.update(run.id, status="running", pid=proc.pid)
                while proc.poll() is None:
                    if self.stop.is_set() or time.monotonic() - start > self.config.timeout_seconds:
                        raise OrchestratorError("Worker interrupted or timed out; changes and logs were retained.")
                    if (log / "events.jsonl").stat().st_size + (log / "stderr.log").stat().st_size > 100 * 1024 * 1024:
                        raise OrchestratorError("Worker output exceeded 100 MiB; stopped to protect disk space.")
                    time.sleep(0.1)
            finally:
                # A completed Pi process can leave test servers or tool children behind.
                # Stop the whole group, including when journal persistence failed after spawn.
                if process_group_alive(proc.pid):
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    deadline = time.monotonic() + 5
                    while process_group_alive(proc.pid) and time.monotonic() < deadline:
                        proc.poll()
                        time.sleep(0.05)
                    if process_group_alive(proc.pid):
                        try:
                            os.killpg(proc.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                proc.wait()
            if process_group_alive(proc.pid):
                raise OrchestratorError("Worker descendants remain; publication and retry are refused while its process group exists.")
            if proc.returncode != 0:
                raise OrchestratorError(f"Worker exited {proc.returncode}. See {log / 'stderr.log'}.")
        check_events(log / "events.jsonl", path)
        audit = read_regular(path / ".gho/effective-context.json", path)
        (log / "effective-context.json").write_text(audit)
        check_audit(audit, run, log / "input")
        raw = read_regular(path / ".gho/result.json", path)
        (log / "result.json").write_text(raw)
        return validate_result(json.loads(raw))

    def verify_publication_approval(self, run: Run) -> Issue:
        issue = self.github.issue(IssueRef.parse(run.issue_url))
        self.require_owned(issue)
        if digest(self.context.snapshot(issue, run.base_commit)) != run.fingerprint:
            raise OrchestratorError("Issue/context changed; do not publish against stale approval.")
        approval = self.store.approval(run.issue_url)
        if not approval or approval["fingerprint"] != run.fingerprint:
            raise OrchestratorError("Approval was revoked or replaced; publication refused.")
        self.prerequisites(issue, run.base_commit)
        return issue

    def publish(self, run_id: str) -> Run:
        with self.store.lock():
            run = self.store.get(run_id)
            if run.status not in {"review", "published"} or process_group_alive(run.pid):
                raise OrchestratorError("Only a stopped, reviewable run can be published.")
            issue = self.verify_publication_approval(run)
            existing = self.github.pull_request(run.branch)
            if existing:
                if existing.base != self.config.base_branch or existing.state != "OPEN":
                    raise OrchestratorError("Existing PR is closed or targets a different branch; do not reuse it.")
                return self.store.update(run.id, status="published", pr_url=existing.url)
            commit = self.workspace.commit(run, issue.title)
            run = self.store.update(run.id, commit=commit)
            self.verify_publication_approval(run)
            self.workspace.push(run)
            self.verify_publication_approval(run)
            # This PR body is delivery metadata, not an input to the worker that just finished.
            result = run.metadata.get("result", {})
            body = f"Closes {issue.ref.url}\n\n{result.get('summary', '')}\n\n## Checks\n" + "\n".join(
                f"- {item}" for item in result.get("tests", [])) + f"\n\nOrchestrator run: `{run.id}`\n"
            pr = self.github.create_pull_request(run.branch, issue.title, body, self.config.base_branch)
            self.mirror_status(issue.ref, "Review")
            return self.store.update(run.id, status="published", pr_url=pr.url)

    def sync(self) -> list[Run]:
        updated = []
        with self.store.lock():
            for run in self.store.runs():
                if run.status != "published":
                    continue
                pr = self.github.pull_request(run.branch)
                if pr and pr.merged and pr.base == self.config.base_branch:
                    run = self.store.update(run.id, status="merged", pr_url=pr.url)
                    self.mirror_status(IssueRef.parse(run.issue_url), "Done")
                    updated.append(run)
        return updated

    def recover(self, *, confirm_stopped: bool = False) -> list[Run]:
        result = []
        with self.store.lock():
            for run in self.store.runs():
                if run.status not in {"preparing", "running"}:
                    continue
                if run.pid is not None and process_group_alive(run.pid):
                    continue
                if run.pid is None and not confirm_stopped:
                    continue  # spawn-before-record crash window needs explicit operator confirmation
                result.append(self.store.update(run.id, status="interrupted",
                                               detail="Previous dispatcher stopped. Review retained work before authorizing retry."))
        return result
