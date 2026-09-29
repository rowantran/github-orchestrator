from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from github_orchestrator import state
from github_orchestrator.domain import IssueRef, OrchestratorError, Run
from github_orchestrator.state import Store


def attempt(root, number=1, status="preparing", **changes):
    values = dict(id=f"run-{number}", issue_url="https://github.com/acme/app/issues/1", fingerprint="approved",
                  status=status, branch=f"branch-{number}", worktree=str(root / f"worktree-{number}"))
    return Run(**(values | changes))


def test_case_aliases_share_approvals_acknowledgments_and_active_claims(tmp_path):
    store = Store(tmp_path / "state")
    lower, upper = IssueRef("acme/app", 1).url, IssueRef("ACME/APP", 1).url
    store.approve(lower, "approved", {"plan": "unchanged"})
    store.acknowledge(upper, "completed")
    assert store.approval(upper)["fingerprint"] == "approved"
    assert store.acknowledgment(lower) == "completed"
    store.create(attempt(tmp_path, issue_url=lower))
    with pytest.raises(OrchestratorError, match="no duplicate launched"):
        store.create(attempt(tmp_path, 2, issue_url=upper))
    assert store.latest(upper).id == "run-1"
    store.revoke(upper)
    assert store.approval(lower) is None


@pytest.mark.parametrize("status", ["preparing", "running", "review", "published"])
def test_active_claim_is_exclusive_across_independent_connections(tmp_path, status):
    stores = [Store(tmp_path / "state") for _ in range(4)]
    barrier = Barrier(len(stores))

    def claim(number):
        barrier.wait(timeout=5)
        try:
            stores[number].create(attempt(tmp_path, number, status))
            return True
        except OrchestratorError as exc:
            assert "no duplicate launched" in str(exc)
            return False

    with ThreadPoolExecutor(max_workers=len(stores)) as pool:
        assert sum(pool.map(claim, range(len(stores)))) == 1
    assert len(stores[0].runs()) == 1
    with stores[0].lock(), pytest.raises(OrchestratorError, match="Another operation holds"):
        with stores[1].lock():
            pytest.fail("second dispatcher acquired the journal lock")


@pytest.mark.parametrize("status", ["failed", "blocked", "interrupted"])
def test_retry_is_explicit_and_preserves_previous_work_and_approval(tmp_path, monkeypatch, status):
    store = Store(tmp_path / "state")
    run = attempt(tmp_path, status=status, pid=123)
    Path(run.worktree).mkdir()
    (Path(run.worktree) / "change.txt").write_text("retain")
    store.create(run)
    store.approve(run.issue_url, run.fingerprint, {"plan": "retained"})
    monkeypatch.setattr(state, "process_group_alive", lambda pid: True)
    with pytest.raises(OrchestratorError, match="previous process group"):
        store.retry(run.id)
    assert store.get(run.id).status == status
    monkeypatch.setattr(state, "process_group_alive", lambda pid: False)
    assert store.retry(run.id).status == "superseded"
    assert store.approval(run.issue_url)["fingerprint"] == run.fingerprint
    assert (Path(run.worktree) / "change.txt").read_text() == "retain"
    replacement = attempt(tmp_path, 2)
    store.create(replacement)
    assert store.latest(run.issue_url).id == replacement.id
    assert len(Store(store.root).runs()) == 2


@pytest.mark.parametrize("status", ["preparing", "running", "review", "published", "merged", "superseded"])
def test_retry_rejects_nonretryable_states(tmp_path, status):
    store = Store(tmp_path / "state")
    run = attempt(tmp_path, status=status)
    store.create(run)
    with pytest.raises(OrchestratorError, match="Only failed, blocked or interrupted"):
        store.retry(run.id)
    assert store.get(run.id).status == status


@pytest.mark.parametrize("error,alive", [(PermissionError, True), (ProcessLookupError, False)])
def test_process_permission_uncertainty_counts_as_alive(monkeypatch, error, alive):
    def killpg(pid, signal):
        assert pid == 123 and signal == 0
        raise error

    monkeypatch.setattr(state.os, "killpg", killpg)
    assert state.process_group_alive(123) is alive
    assert state.process_group_alive(None) is False
