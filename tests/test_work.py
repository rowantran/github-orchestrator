from types import SimpleNamespace

import pytest

from github_orchestrator.config import Config
from github_orchestrator.domain import Issue, IssueRef, PullRequest
from github_orchestrator.work import survey

REPO = "acme/app"


def issue(number, *, blockers=(), state="OPEN", reason=None, repo=REPO, prs=()):
    return Issue(IssueRef(repo, number), f"Issue {number}", f"Body {number}", state, reason,
                 blockers=tuple(IssueRef(*b) if isinstance(b, tuple) else IssueRef(REPO, b) for b in blockers),
                 pull_requests=prs)


class FakeGitHub:
    def __init__(self, queue, others=()):
        self.queued = queue
        self.issues = {i.ref.key: i for i in (*queue, *others)}

    def queue(self):
        return self.queued

    def issue(self, ref):
        return self.issues[ref.key]


def fake_workspace(worktrees=None, branches=()):
    config = Config(REPO, "owner", "PVT_q", "https://github.com/users/owner/projects/1", None)
    worktrees = worktrees or {}
    return SimpleNamespace(config=config, worktrees=lambda: worktrees,
                           branch_exists=lambda b: b in worktrees or b in branches)


def states(items):
    return {item["number"]: item["state"] for item in items}


def test_ready_needs_every_blocker_completed_and_no_branch():
    done = issue(1, state="CLOSED", reason="COMPLETED")
    not_planned = issue(2, state="CLOSED", reason="NOT_PLANNED")
    still_open = issue(3)
    queue = [issue(10), issue(11, blockers=(1,)), issue(12, blockers=(1, 3)), issue(13, blockers=(2,)),
             issue(14, blockers=(1,))]
    items = survey(FakeGitHub(queue, [done, not_planned, still_open]),
                   fake_workspace({"owner/gh-14": "/work/gh-14"}))
    assert states(items) == {10: "ready", 11: "ready", 12: "blocked", 13: "blocked", 14: "in_progress"}
    by_number = {item["number"]: item for item in items}
    assert by_number[14]["worktree"] == "/work/gh-14"
    assert by_number[10]["branch"] == "owner/gh-10" and by_number[10]["worktree"] is None
    assert by_number[10]["body"] == "Body 10"
    assert by_number[13]["blockers"][0]["state_reason"] == "NOT_PLANNED"


def test_branch_without_worktree_counts_as_in_progress():
    items = survey(FakeGitHub([issue(5)]), fake_workspace(branches={"owner/gh-5"}))
    assert items[0]["state"] == "in_progress" and items[0]["worktree"] is None


@pytest.mark.parametrize("worktrees,branches,expected", [
    ({"owner/gh-1": "/work/gh-1"}, set(), ("owner/gh-1", "/work/gh-1")),
    ({}, {"owner/gh-1"}, ("owner/gh-1", None)),
    ({}, set(), (None, None)),
])
def test_blocked_issue_reports_where_to_stack(worktrees, branches, expected):
    pr = PullRequest(9, "https://github.com/acme/app/pull/9", "OPEN", False, "main", "someone/feature", repo=REPO)
    items = survey(FakeGitHub([issue(2, blockers=(1,))], [issue(1, prs=(pr,))]), fake_workspace(worktrees, branches))
    blocker = items[0]["blockers"][0]
    assert items[0]["state"] == "blocked"
    assert (blocker["branch"], blocker["worktree"]) == expected
    assert blocker["pull_requests"] == [{"url": pr.url, "state": "OPEN", "head": "someone/feature", "base": "main"}]


def test_blockers_in_other_repositories_never_match_local_branches():
    other = issue(1, repo="other/repo")
    items = survey(FakeGitHub([issue(2, blockers=(("other/repo", 1),))], [other]),
                   fake_workspace({"owner/gh-1": "/work/gh-1"}))
    assert items[0]["blockers"][0]["branch"] is None
    assert items[0]["blockers"][0]["repo"] == "other/repo"
