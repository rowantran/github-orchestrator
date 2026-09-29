from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from github_orchestrator import context
from github_orchestrator import runner as runner_module
from github_orchestrator.config import Config
from github_orchestrator.domain import Issue, IssueRef, OrchestratorError, PullRequest, Run, digest
from github_orchestrator.runner import Runner, check_audit, read_regular
from github_orchestrator.state import process_group_alive
from github_orchestrator.workspace import Workspace


def issue(number=1, **changes):
    return replace(Issue(IssueRef("acme/app", number), f"Task {number}", "Original plan", "OPEN", None,
                         assignees=("owner",), project_ids=("PVT_queue",)), **changes)


def pr(number=10, **changes):
    return replace(PullRequest(number, f"https://github.com/acme/app/pull/{number}", "OPEN", False,
                               "main", "branch", repo="acme/app"), **changes)


class FakeGitHub:
    def __init__(self):
        self.issues = {issue().ref.key: issue()}
        self.prs = {}
        self.writes = []
        self.create_failure = None

    def issue(self, ref):
        return self.issues[ref.key]

    def queue(self):
        return list(self.issues.values())

    def set_project_status(self, ref, status):
        self.writes.append((ref, status))
        return True

    def pull_request(self, branch):
        return self.prs.get(branch)

    def create_pull_request(self, branch, title, body, base):
        self.writes.append((branch, "create_pr"))
        if self.create_failure == "before":
            raise OrchestratorError("API unavailable")
        self.prs[branch] = pr(head=branch, base=base)
        if self.create_failure == "after":
            raise OrchestratorError("response lost")
        return self.prs[branch]


class FakeWorkspace:
    def __init__(self):
        self.base = "base-sha"
        self.context = "Approved context"
        self.integrated = set()
        self.commits = []
        self.pushes = []
        self.push_failure = False

    def fetch(self):
        return self.base

    def source(self, base, path):
        return self.context

    def ancestor(self, commit, base):
        assert base == self.base
        return commit in self.integrated

    def create(self, run):
        Path(run.worktree).mkdir(parents=True)
        (Path(run.worktree) / "change.txt").write_text("retained work")

    def git(self, *args, **kwargs):
        assert args[0] == "rev-parse"
        return self.base

    def changed_files(self, run):
        return ["change.txt"]

    def commit(self, run, title):
        if not run.commit:
            self.commits.append(run.id)
        return run.commit or "publication-sha"

    def push(self, run):
        self.pushes.append(run.commit)
        if self.push_failure:
            raise OrchestratorError("push failed")


@pytest.fixture
def runner(tmp_path, monkeypatch):
    config = Config("acme/app", "owner", "PVT_queue", "https://github.com/orgs/acme/projects/1",
                    tmp_path / "checkout", tmp_path / "state", tmp_path / "workspace", "test-model",
                    tmp_path / "provider.ts", tmp_path / "isara", context_files=("README.md",))
    monkeypatch.setattr(context, "bootstrap_prompt", lambda path: "bootstrap fixture")
    sandbox = SimpleNamespace(prerequisites=lambda: None, prepare=lambda path: {}, environment=lambda path: {})
    result = Runner(config, github=FakeGitHub(), workspace=FakeWorkspace(), sandbox=sandbox)
    monkeypatch.setattr(runner_module, "process_group_alive", lambda pid: False)
    return result


def approve(runner, task=None):
    task = task or issue()
    runner.github.issues[task.ref.key] = task
    return runner.approve(task.ref)


def attempt(runner, status="review", pid=None):
    fingerprint = approve(runner)
    run = Run("run-1", issue().ref.url, fingerprint, status, "owner/agents/run-1",
              str(runner.config.tasks_dir / "run-1"), runner.workspace.base, pid=pid,
              metadata={"result": {"summary": "Changed code", "tests": ["unit tests"]}})
    runner.workspace.create(run)
    runner.store.create(run)
    return run


def audit_bundle(runner, run):
    snapshot = runner.context.snapshot(issue(), run.base_commit)
    bundle = runner.context.bundle(snapshot, run_id=run.id, branch=run.branch, base_commit=run.base_commit)
    inputs = runner.config.state_dir / "attempts" / run.id / "input"
    runner.context.write_bundle(inputs, bundle)
    audit = json.loads(bundle["context.json"])
    audit.update(cwd=run.worktree, context_path=str(Path(run.worktree) / ".gho/input/context.json"),
                 system_prompt=bundle["system.md"] + bundle["append.md"] + snapshot["expected_bootstrap"],
                 task_prompt=bundle["task.md"], tools=[
                     {key: value for key, value in tool.items() if key != "label"}
                     for tool in reversed(list(json.loads(bundle["tool-definitions.json"])["tools"].values()))])
    return audit, inputs


@pytest.mark.parametrize("changes", [{"assignees": ()}, {"assignees": ("other",)},
                                     {"project_ids": ("PVT_other",)}, {"ref": IssueRef("other/app", 1)},
                                     {"state": "CLOSED", "state_reason": "NOT_PLANNED"}])
def test_owner_repository_project_and_open_state_gate_approval(runner, changes):
    task = issue(**changes)
    runner.github.issues[task.ref.key] = task
    with pytest.raises(OrchestratorError, match="not an open task"):
        runner.approve(task.ref)
    assert runner.store.approval(task.ref.url) is None
    assert not runner.readiness(task, runner.workspace.base).ready
    assert runner.github.writes == []


def test_approval_is_explicit_and_names_are_case_insensitive(runner):
    task = issue(ref=IssueRef("ACME/APP", 1), assignees=("OWNER",))
    assert runner.readiness(task, "base-sha").reason == "needs approval"
    fingerprint = approve(runner, task)
    assert runner.readiness(task, "base-sha").fingerprint == fingerprint
    assert runner.readiness(task, "base-sha").ready
    assert runner.readiness(issue(), "base-sha").ready
    assert runner.context.snapshot(task, "base-sha") == runner.context.snapshot(issue(), "base-sha")
    assert runner.store.approval(issue().ref.url)["fingerprint"] == fingerprint
    upper = replace(task, blockers=(IssueRef("OTHER/REPO", 2),))
    lower = replace(issue(), blockers=(IssueRef("other/repo", 2),))
    assert runner.context.snapshot(upper, "base-sha") == runner.context.snapshot(lower, "base-sha")


@pytest.mark.parametrize("change", ["body", "blockers", "context", "model", "resources"])
def test_changed_plan_or_context_invalidates_approval_and_preview(runner, monkeypatch, change):
    fingerprint = approve(runner)
    task = issue()
    if change in {"body", "blockers"}:
        task = replace(task, **({"body": "New plan"} if change == "body" else {"blockers": (IssueRef("acme/app", 2),)}))
    elif change == "context":
        runner.workspace.context = "New context"
    elif change == "model":
        runner.context.config = replace(runner.config, model="different-model")
    else:
        monkeypatch.setattr(context, "hashes", lambda *args: {"changed": "hash"})
    runner.github.issues[task.ref.key] = task
    assert runner.readiness(task, "base-sha").reason == "plan/context changed; approve again"
    with pytest.raises(OrchestratorError, match="changed since preview"):
        runner.approve(task.ref, expected=fingerprint)
    assert runner.store.approval(task.ref.url)["fingerprint"] == fingerprint


def test_a_and_b_must_both_be_successfully_merged_before_c(runner):
    a, b = issue(2), issue(3)
    task = issue(blockers=(a.ref, b.ref))
    approve(runner, task)
    for blocker in (a, b):
        runner.github.issues[blocker.ref.key] = blocker
    for blocker in (a, b):
        assert not runner.readiness(task, "base-sha").ready
        merged = pr(blocker.ref.number, state="MERGED", merged=True, merge_commit=f"merge-{blocker.ref.number}")
        runner.github.issues[blocker.ref.key] = replace(blocker, state="CLOSED", state_reason="COMPLETED",
                                                       pull_requests=(merged,))
        assert not runner.readiness(task, "base-sha").ready  # Merge must also be in the fetched base.
        runner.workspace.integrated.add(merged.merge_commit)
    ready = runner.readiness(task, "base-sha")
    assert ready.ready and len(ready.prerequisites) == 2


@pytest.mark.parametrize("reason", ["NOT_PLANNED", "DUPLICATE", None])
def test_canceled_blocker_never_succeeds_even_with_merged_pr_and_acknowledgment(runner, reason):
    blocker = issue(2, state="CLOSED", state_reason=reason,
                    pull_requests=(pr(merged=True, merge_commit="merged"),))
    task = issue(blockers=(blocker.ref,))
    approve(runner, task)
    runner.github.issues[blocker.ref.key] = blocker
    runner.workspace.integrated.add("merged")
    runner.store.acknowledge(blocker.ref.url, digest(blocker.plan()))
    assert not runner.readiness(task, "base-sha").ready


@pytest.mark.parametrize("cross_repo", [False, True])
def test_outside_queue_blockers_are_read_only_and_nocode_ack_is_plan_bound(runner, cross_repo):
    blocker = issue(2, ref=IssueRef("external/repo" if cross_repo else "acme/app", 2), assignees=("other",),
                    project_ids=(), state="CLOSED", state_reason="COMPLETED")
    task = issue(blockers=(blocker.ref,))
    approve(runner, task)
    runner.github.issues[blocker.ref.key] = blocker
    writes = list(runner.github.writes)
    assert not runner.readiness(task, "base-sha").ready
    runner.store.acknowledge(blocker.ref.url, digest(blocker.plan()))
    assert runner.readiness(task, "base-sha").ready
    runner.github.issues[blocker.ref.key] = replace(blocker, body="Changed prerequisite")
    assert not runner.readiness(task, "base-sha").ready
    assert runner.github.writes == writes
    assert runner.store.approval(blocker.ref.url) is None


def test_merged_external_blocker_is_read_only_and_does_not_need_local_ancestry(runner):
    blocker = issue(2, ref=IssueRef("external/repo", 2), assignees=(), project_ids=(), state="CLOSED",
                    state_reason="COMPLETED", pull_requests=(pr(merged=True, repo="external/repo"),))
    task = issue(blockers=(blocker.ref,))
    approve(runner, task)
    runner.github.issues[blocker.ref.key] = blocker
    writes = list(runner.github.writes)
    ready = runner.readiness(task, "base-sha")
    assert ready.ready and ready.prerequisites == blocker.pull_requests
    assert not runner.workspace.integrated and runner.github.writes == writes


@pytest.mark.parametrize("change", ["body", "owner", "approval"])
def test_preparation_rechecks_gates_before_launch_and_retains_work(runner, monkeypatch, change):
    approve(runner)

    def prepare(path):
        if change == "approval":
            runner.store.revoke(issue().ref.url)
        else:
            runner.github.issues[issue().ref.key] = issue(**({"body": "Changed"} if change == "body" else {"assignees": ()}))
        return {}

    launched = []
    monkeypatch.setattr(runner.sandbox, "prepare", prepare)
    monkeypatch.setattr(runner, "launch", lambda run: launched.append(run))
    run = runner.execute(issue().ref)
    assert launched == []
    assert run.status == "failed"
    assert (Path(run.worktree) / "change.txt").read_text() == "retained work"


@pytest.mark.parametrize("status,pid,alive,confirm,interrupted", [
    ("preparing", None, False, False, False), ("running", None, False, False, False),
    ("preparing", None, False, True, True), ("running", 123, True, True, False),
    ("running", 123, False, False, True), ("review", 123, False, True, False),
])
def test_recovery_never_duplicates_live_or_unknown_workers(runner, monkeypatch, status, pid, alive, confirm, interrupted):
    run = attempt(runner, status, pid)
    monkeypatch.setattr(runner_module, "process_group_alive", lambda value: alive)
    recovered = runner.recover(confirm_stopped=confirm)
    assert bool(recovered) is interrupted
    assert runner.store.get(run.id).status == ("interrupted" if interrupted else status)
    assert not runner.readiness(issue(), "base-sha").ready
    assert (Path(run.worktree) / "change.txt").exists()
    if status in {"preparing", "running"} and not interrupted:
        with pytest.raises(OrchestratorError, match="Unreconciled"):
            runner.run_ready()


@pytest.mark.parametrize("status", ["failed", "blocked", "interrupted"])
def test_failed_attempts_require_explicit_retry_before_dispatch(runner, status):
    run = attempt(runner, status)
    assert not runner.readiness(issue(), "base-sha").ready
    assert runner.run_ready() == []
    runner.store.retry(run.id)
    assert runner.readiness(issue(), "base-sha").ready
    assert (Path(run.worktree) / "change.txt").exists()


@pytest.mark.parametrize("change", ["body", "context", "approval", "owner"])
def test_publication_refuses_stale_or_unowned_work_without_commit_push_or_pr(runner, change):
    run = attempt(runner)
    if change == "context":
        runner.workspace.context = "Changed"
    elif change == "approval":
        runner.store.revoke(run.issue_url)
    else:
        runner.github.issues[issue().ref.key] = issue(**({"body": "Changed"} if change == "body" else {"assignees": ()}))
    with pytest.raises(OrchestratorError):
        runner.publish(run.id)
    assert runner.workspace.commits == runner.workspace.pushes == []
    assert not runner.github.prs
    assert runner.store.get(run.id).status == "review"


@pytest.mark.parametrize("state,base", [("OPEN", "main"), ("CLOSED", "main"), ("OPEN", "release")])
def test_existing_pr_is_reused_or_rejected_without_duplicate_write(runner, state, base):
    run = attempt(runner)
    existing = pr(head=run.branch, state=state, base=base)
    runner.github.prs[run.branch] = existing
    if (state, base) == ("OPEN", "main"):
        assert runner.publish(run.id).pr_url == existing.url
        assert runner.publish(run.id).status == "published"
    else:
        with pytest.raises(OrchestratorError):
            runner.publish(run.id)
    assert runner.workspace.commits == runner.workspace.pushes == []
    assert all(action != "create_pr" for _, action in runner.github.writes)


@pytest.mark.parametrize("stage", ["push", "before", "after"])
def test_partial_publication_retains_commit_and_retry_does_not_duplicate_pr(runner, stage):
    run = attempt(runner)
    runner.workspace.push_failure = stage == "push"
    runner.github.create_failure = stage if stage != "push" else None
    with pytest.raises(OrchestratorError):
        runner.publish(run.id)
    saved = runner.store.get(run.id)
    assert saved.status == "review" and saved.commit == "publication-sha"
    assert (Path(saved.worktree) / "change.txt").exists()
    pushes = len(runner.workspace.pushes)
    runner.workspace.push_failure = False
    runner.github.create_failure = None
    assert runner.publish(run.id).status == "published"
    assert runner.workspace.commits == [run.id]
    assert len(runner.github.prs) == 1
    assert len(runner.workspace.pushes) == pushes + (stage != "after")
    assert sum(action == "create_pr" for _, action in runner.github.writes) == (2 if stage == "before" else 1)


def test_crash_between_git_commit_and_journal_update_preserves_work_and_fails_closed(runner, monkeypatch):
    config = replace(runner.config, checkout=runner.config.clone)
    config.clone.mkdir(parents=True)
    workspace = Workspace(config)
    workspace.git("init", "-b", "main")
    workspace.git("config", "user.name", "Test User")
    workspace.git("config", "user.email", "test@example.invalid")
    workspace.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial")
    runner.workspace.base = workspace.git("rev-parse", "HEAD")

    def create(run):
        workspace.git("worktree", "add", "-b", run.branch, run.worktree, run.base_commit)
        (Path(run.worktree) / "change.txt").write_text("retained work")

    monkeypatch.setattr(runner.workspace, "create", create)
    monkeypatch.setattr(runner.workspace, "commit", workspace.commit)
    run = attempt(runner)
    update = runner.store.update

    def crash(run_id, **changes):
        if "commit" in changes:
            raise OSError("journal unavailable after Git commit")
        return update(run_id, **changes)

    monkeypatch.setattr(runner.store, "update", crash)
    with pytest.raises(OSError, match="journal unavailable"):
        runner.publish(run.id)
    head = workspace.git("rev-parse", "HEAD", cwd=Path(run.worktree))
    assert head != run.base_commit
    assert runner.store.get(run.id).commit is None
    monkeypatch.setattr(runner.store, "update", update)
    with pytest.raises(OrchestratorError, match="Unexpected commits"):
        runner.publish(run.id)
    assert workspace.git("rev-parse", "HEAD", cwd=Path(run.worktree)) == head
    assert runner.workspace.pushes == [] and not runner.github.prs
    assert (Path(run.worktree) / "change.txt").read_text() == "retained work"


def test_plan_change_during_commit_prevents_push(runner, monkeypatch):
    run = attempt(runner)
    commit = runner.workspace.commit

    def change_plan(run, title):
        runner.github.issues[issue().ref.key] = issue(body="Changed during commit")
        return commit(run, title)

    monkeypatch.setattr(runner.workspace, "commit", change_plan)
    with pytest.raises(OrchestratorError):
        runner.publish(run.id)
    assert runner.workspace.pushes == []
    assert not runner.github.prs
    assert runner.store.get(run.id).commit == "publication-sha"


@pytest.mark.parametrize("case", ["success", "exit1", "exit0_only", "assistant_error", "unsettled", "new_turn",
                                  "invalid_json", "wrong_cwd", "no_session", "invalid_audit"])
def test_launch_requires_successful_current_settled_json_turn_not_just_exit_zero(runner, monkeypatch, case):
    run = attempt(runner, "preparing")
    path = Path(run.worktree)
    (path / ".gho").mkdir()
    result = {"status": "ready_for_review", "summary": "Done", "tests": ["unit tests"], "blockers": []}
    (path / ".gho/result.json").write_text(json.dumps(result))
    audit, _ = audit_bundle(runner, run)
    if case == "invalid_audit":
        audit["run_id"] = "different-run"
    (path / ".gho/effective-context.json").write_text(json.dumps(audit))
    events = [{"type": "session", "cwd": str(path)}, {"type": "agent_start"},
              {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop"}},
              {"type": "agent_settled"}]
    if case == "assistant_error":
        events[2]["message"]["stopReason"] = "error"
    if case == "wrong_cwd":
        events[0]["cwd"] = str(path.parent)
    if case == "no_session":
        events.pop(0)
    if case == "unsettled":
        events.pop()
    if case == "new_turn":
        events += [{"type": "agent_start"}, {"type": "agent_settled"}]
    raw = "\n".join(json.dumps(event) for event in events)
    raw = "" if case == "exit0_only" else raw + ("\n{broken" if case == "invalid_json" else "\n")

    def popen(argv, **kwargs):
        assert kwargs["start_new_session"] and kwargs["cwd"] == path
        assert "locked" in argv and "--mode" in argv and "json" in argv
        kwargs["stdout"].write(raw.encode())
        code = 1 if case == "exit1" else 0
        return SimpleNamespace(pid=999999, returncode=code, poll=lambda: code, wait=lambda: code)

    monkeypatch.setattr(runner_module.subprocess, "Popen", popen)
    if case == "success":
        assert runner.launch(run) == result
        assert (runner.config.state_dir / "attempts" / run.id / "result.json").exists()
    else:
        with pytest.raises(OrchestratorError):
            runner.launch(run)
    assert (runner.config.state_dir / "attempts" / run.id / "events.jsonl").exists()


@pytest.mark.parametrize("kind", ["outside", "inside", "parent", "directory", "oversized"])
def test_worker_output_rejects_symlinks_escape_and_nonregular_files(tmp_path, kind):
    root = tmp_path / "worktree"
    root.mkdir()
    target = tmp_path / "secret"
    target.write_text("not worker output")
    output = root / "result.json"
    if kind in {"inside", "outside"}:
        if kind == "inside":
            target = root / "other.json"
            target.write_text("{}")
        output.symlink_to(target)
    elif kind == "parent":
        (root / "linked").symlink_to(tmp_path, target_is_directory=True)
        output = root / "linked/secret"
    elif kind == "directory":
        output.mkdir()
    else:
        output.write_text("x" * 33)
    with pytest.raises(OrchestratorError):
        read_regular(output, root, limit=32)
    assert target.read_text() in {"not worker output", "{}"}


@pytest.mark.parametrize("field", ["schema", "run_id", "issue", "base_commit", "branch", "context_files",
                                   "expected_bootstrap", "cwd", "context_path", "system_prompt", "task_prompt", "tools"])
def test_context_audit_requires_every_manifest_and_runtime_field(runner, field):
    run = attempt(runner)
    audit, inputs = audit_bundle(runner, run)
    check_audit(json.dumps(audit), run, inputs)
    del audit[field]
    with pytest.raises(OrchestratorError):
        check_audit(json.dumps(audit), run, inputs)


@pytest.mark.parametrize("damage", ["system.md", "append.md", "bootstrap", "task.md", "tool_description",
                                    "tool_parameters", "tool_label", "duplicate_tool"])
def test_context_audit_checks_frozen_prompts_and_exact_tool_metadata(runner, damage):
    run = attempt(runner)
    audit, inputs = audit_bundle(runner, run)
    if damage in {"system.md", "append.md", "bootstrap", "task.md"}:
        key = "task_prompt" if damage == "task.md" else "system_prompt"
        expected = audit["expected_bootstrap"] if damage == "bootstrap" else (inputs / damage).read_text()
        audit[key] = audit[key].replace(expected, "")
    elif damage == "duplicate_tool":
        audit["tools"].append(audit["tools"][0])
    else:
        key = damage.removeprefix("tool_")
        audit["tools"][0][key] = "not approved"
    with pytest.raises(OrchestratorError):
        check_audit(json.dumps(audit), run, inputs)


# A local process-protocol fixture, never a real Pi process or a sandbox bypass.
LOCAL_WORKER = """
import json, os, signal, subprocess, sys, time
from pathlib import Path
root = Path('.gho')
root.mkdir(exist_ok=True)
mode = sys.argv[1]
if mode == 'child':
    subprocess.Popen([sys.executable, '-c',
        "import os,time; from pathlib import Path; "
        "Path('.gho/child.pid').write_text(str(os.getpid())); time.sleep(60)"])
    deadline = time.monotonic() + 5
    while not (root / 'child.pid').exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert (root / 'child.pid').exists()
if mode == 'ignore_term':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
(root / 'result.json').write_text(json.dumps({
    'status': 'ready_for_review', 'summary': 'Local fixture', 'tests': [], 'blockers': []}))
(root / 'effective-context.json').write_text((root / 'expected-audit.json').read_text())
for event in [{'type': 'session', 'cwd': str(Path.cwd())}, {'type': 'agent_start'},
              {'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'stop'}},
              {'type': 'agent_settled'}]:
    print(json.dumps(event), flush=True)
(root / 'ready').write_text(str(os.getpid()))
if mode != 'child':
    time.sleep(60)
"""


@pytest.fixture
def local_worker(runner, tmp_path, monkeypatch):
    runner.config = replace(runner.config, timeout_seconds=1)
    run = attempt(runner, "preparing")
    root = Path(run.worktree) / ".gho"
    root.mkdir()
    audit, _ = audit_bundle(runner, run)
    (root / "expected-audit.json").write_text(json.dumps(audit))
    script = tmp_path / "local_worker.py"
    script.write_text(LOCAL_WORKER)
    processes = []
    real_popen = subprocess.Popen
    monkeypatch.setattr(runner_module, "process_group_alive", process_group_alive)

    def popen(argv, **kwargs):
        assert kwargs["start_new_session"] is True
        proc = real_popen(argv, **kwargs)
        processes.append(proc)
        deadline = time.monotonic() + 5
        while not (root / "ready").exists() and time.monotonic() < deadline:
            assert proc.poll() is None or (root / "ready").exists(), "local worker exited before readiness"
            time.sleep(0.01)
        assert (root / "ready").read_text() == str(proc.pid)
        if argv[-1] == "child":
            assert proc.wait(timeout=5) == 0  # Exercise cleanup with the leader already reaped.
            assert process_group_alive(proc.pid)
            assert os.getpgid(int((root / "child.pid").read_text())) == proc.pid
        return proc

    def launch(mode):
        monkeypatch.setattr(runner, "argv", lambda run: [sys.executable, str(script), mode])
        return runner.launch(run)

    monkeypatch.setattr(runner_module.subprocess, "Popen", popen)
    try:
        yield SimpleNamespace(launch=launch, run=run, root=root, processes=processes)
    finally:
        for proc in processes:  # Also clean up if a regression leaks a real process.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)


@pytest.mark.parametrize("mode,expected_signal", [("timeout", signal.SIGTERM), ("ignore_term", signal.SIGKILL)])
def test_real_worker_timeout_kills_and_reaps_process_but_retains_work(runner, local_worker, mode, expected_signal):
    with pytest.raises(OrchestratorError, match="timed out"):
        local_worker.launch(mode)
    proc, = local_worker.processes
    assert proc.returncode == -expected_signal
    assert not process_group_alive(proc.pid)
    assert runner.store.get(local_worker.run.id).pid == proc.pid
    assert runner.recover()[0].status == "interrupted"
    log = runner.config.state_dir / "attempts" / local_worker.run.id
    assert (log / "events.jsonl").read_text().count('"agent_settled"') == 1
    assert (local_worker.root / "result.json").exists()
    assert (local_worker.root.parent / "change.txt").read_text() == "retained work"


def test_real_worker_success_kills_surviving_tool_child_after_leader_exit(local_worker):
    assert local_worker.launch("child")["status"] == "ready_for_review"
    proc, = local_worker.processes
    assert proc.returncode == 0
    assert not process_group_alive(proc.pid)
    with pytest.raises(ProcessLookupError):
        os.kill(int((local_worker.root / "child.pid").read_text()), 0)


def test_real_worker_is_killed_when_running_pid_cannot_be_journaled(runner, local_worker, monkeypatch):
    failure = OSError("journal write failed after spawn")

    def update(run_id, **changes):
        proc, = local_worker.processes
        assert changes == {"status": "running", "pid": proc.pid} and proc.poll() is None
        raise failure

    monkeypatch.setattr(runner.store, "update", update)
    with pytest.raises(OSError) as error:
        local_worker.launch("journal_failure")
    assert error.value is failure
    proc, = local_worker.processes
    assert proc.returncode == -signal.SIGTERM and not process_group_alive(proc.pid)
    saved = runner.store.get(local_worker.run.id)
    assert saved.status == "preparing" and saved.pid is None
    assert (local_worker.root.parent / "change.txt").exists()
