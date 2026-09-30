from __future__ import annotations

import copy
import json
from collections.abc import Callable

import pytest

from github_orchestrator.domain import IssueRef, OrchestratorError
from github_orchestrator.github import GitHub
from github_orchestrator.process import CommandError, Commands

REPO = "acme/app"
PROJECT = "PVT_queue"
OWNER = "worker"
BRANCH = "work/issue-1"


def connection_pages(nodes: list[dict], size: int = 100) -> list[dict]:
    chunks = [nodes[i:i + size] for i in range(0, len(nodes), size)] or [[]]
    return [{
        "totalCount": len(nodes), "nodes": chunk,
        "pageInfo": {"hasNextPage": i < len(chunks) - 1, "endCursor": f"cursor-{i + 1}"},
    } for i, chunk in enumerate(chunks)]


def rest_issue(number: int, repo: str = REPO, assignee: str = OWNER) -> dict:
    return {"id": 1000 + number, "number": number, "html_url": IssueRef(repo, number).url,
            "state": "open", "assignees": [{"login": assignee}]}


def pr_node(number: int = 10, *, state: str = "OPEN", repo: str = REPO, head_repo: str = REPO) -> dict:
    return {
        "id": f"PR_{repo}_{number}", "number": number, "url": f"https://github.com/{repo}/pull/{number}",
        "state": state, "merged": state == "MERGED", "baseRefName": "main", "headRefName": BRANCH,
        "mergeCommit": {"oid": "a" * 40} if state == "MERGED" else None,
        "repository": {"nameWithOwner": repo}, "headRepository": {"nameWithOwner": head_repo},
    }


class FixtureCommands(Commands):
    """A command-level fixture: no subprocesses, credentials, or GitHub writes."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.issues: dict[tuple[str, int], dict] = {}
        self.connections: dict[tuple[str, int, str], list[dict]] = {}
        self.dependencies: dict[tuple[str, int], list[list[dict]]] = {}
        self.queue_pages: list[list[dict]] = [[]]
        self.project = {"id": PROJECT, "url": "https://github.com/orgs/acme/projects/7", "title": "Queue"}
        self.before: Callable[[list[str]], None] = lambda args: None
        self.graphql_errors: list[dict] = []

    def add_issue(self, number: int = 1, *, repo: str = REPO, assignee: str = OWNER,
                  project: str | None = PROJECT, blockers: tuple[IssueRef, ...] = (),
                  prs: tuple[dict, ...] = (), state: str = "OPEN", reason: str | None = None) -> IssueRef:
        ref = IssueRef(repo, number)
        self.issues[repo.lower(), number] = {
            "id": f"I_{repo}_{number}", "number": number, "url": ref.url,
            "repository": {"nameWithOwner": repo}, "title": f"Issue {number}", "body": "Details",
            "state": state, "stateReason": reason,
            "issueDependenciesSummary": {"totalBlockedBy": len(blockers)},
        }
        self.connections[repo.lower(), number, "assignees"] = connection_pages([{"id": "U_worker", "login": assignee}])
        items = [{"id": f"PVTI_{number}", "project": {"id": project}}] if project else []
        self.connections[repo.lower(), number, "projectItems"] = connection_pages(items)
        self.connections[repo.lower(), number, "closedByPullRequestsReferences"] = connection_pages(list(prs))
        self.dependencies[repo.lower(), number] = [[rest_issue(b.number, b.repo) for b in blockers]]
        return ref

    def run(self, argv, **kwargs):
        assert isinstance(argv, list) and all(isinstance(arg, str) for arg in argv)
        assert argv[0] == "gh"
        assert kwargs["env"]["GH_HOST"] == "github.com"
        self.calls.append(argv)
        args = argv[1:]
        self.before(args)
        if args[:3] == ["api", "--hostname", "github.com"]:
            endpoint = args[3]
            if endpoint == "graphql":
                params = dict(arg.split("=", 1) for arg in args[4:] if "=" in arg)
                query = params["query"]
                if "node(id:" in query:
                    data = {"node": copy.deepcopy(self.project)}
                elif "issue(number:" in query:
                    repo, number = f"{params['owner']}/{params['name']}", int(params["number"])
                    issue = copy.deepcopy(self.issues.get((repo.lower(), number)))
                    if issue is not None:
                        for field in ("assignees", "projectItems", "closedByPullRequestsReferences"):
                            if f"{field}(" in query:
                                page = int(params.get("cursor", "cursor-0").split("-")[1])
                                issue[field] = self.connections[repo.lower(), number, field][page]
                    data = {"repository": {"issue": issue}}
                else:
                    raise AssertionError(f"Unexpected GraphQL: {query}")
                response = {"data": data}
                if self.graphql_errors:
                    response["errors"] = self.graphql_errors
                return json.dumps(response)
            if endpoint == "user":
                return json.dumps({"login": OWNER})
            parts = endpoint.split("/")
            assert parts[0] == "repos"
            repo = "/".join(parts[1:3])
            if parts[3].startswith("issues?"):
                assert "--paginate" in args and "--slurp" in args and "per_page=100" in endpoint
                return json.dumps(self.queue_pages)
            number = int(parts[4])
            if len(parts) == 5:
                return json.dumps(rest_issue(number, repo))
            if "--method" in args:
                assert args[args.index("--method") + 1] == "POST"
                return "{}"
            assert "--paginate" in args and "--slurp" in args and "per_page=100" in endpoint
            return json.dumps(self.dependencies[repo.lower(), number])
        if args[:2] == ["project", "view"]:
            return json.dumps(self.project)
        if args[:2] == ["project", "item-add"]:
            return json.dumps({"id": "PVTI_1"})
        if args[:2] == ["issue", "create"]:
            return IssueRef(REPO, 1).url + "\n"
        raise AssertionError(f"Unexpected command: {argv}")


@pytest.fixture
def commands():
    return FixtureCommands()


@pytest.fixture
def github(commands):
    return GitHub(REPO, PROJECT, OWNER, commands)


def test_queue_pages_and_exact_repository_project_and_assignee(github, commands):
    commands.add_issue(1)
    commands.add_issue(2, project="PVT_other")
    commands.add_issue(3, assignee="someone-else")
    commands.add_issue(4)
    commands.queue_pages = [
        [rest_issue(1), rest_issue(2), rest_issue(20, "other/repo"), rest_issue(30, assignee="other")],
        [rest_issue(3), rest_issue(4), {**rest_issue(10), "pull_request": {"url": "ignored"}}],
    ]
    assert [issue.ref.number for issue in github.queue()] == [1, 4]
    request = next(call for call in commands.calls if any("issues?" in arg for arg in call))
    assert "repos/acme/app/issues?state=open&assignee=worker&per_page=100" in request


def test_queue_ignores_closed_issues_and_checks_live_assignment(github, commands):
    commands.add_issue(1, state="CLOSED", reason="COMPLETED")
    commands.add_issue(2, assignee="other")
    commands.queue_pages = [[rest_issue(1), rest_issue(2), {**rest_issue(3), "state": "closed"}]]
    assert github.queue() == []


def test_queue_is_case_insensitive_for_github_names(github, commands):
    commands.add_issue(1, repo="ACME/APP", assignee="WORKER")
    commands.queue_pages = [[rest_issue(1, "ACME/APP", "WORKER")]]
    queued = github.queue()
    assert len(queued) == 1
    assert queued[0].assignees == ("WORKER",)
    assert queued[0].ref.url == "https://github.com/acme/app/issues/1"
    assert commands.issues[REPO, 1]["repository"]["nameWithOwner"] == "ACME/APP"
    # Request casing must not matter, but the API response keeps its original casing.
    assert github.issue(IssueRef("AcMe/ApP", 1)).ref.key == queued[0].ref.key


@pytest.mark.parametrize("project", [None, {}, {"id": "PVT_wrong", "url": "x", "title": "x"}])
def test_empty_queue_still_requires_project_access(github, commands, project):
    commands.project = project
    with pytest.raises(OrchestratorError):
        github.queue()


def test_issue_paginates_all_native_relationships(github, commands):
    blockers = tuple(IssueRef("outside/repo", n) for n in range(1, 102))
    ref = commands.add_issue(blockers=blockers)
    commands.dependencies[REPO, 1] = [[rest_issue(b.number, b.repo) for b in blockers[:100]],
                                      [rest_issue(b.number, b.repo) for b in blockers[100:]]]
    commands.connections[REPO, 1, "assignees"] = connection_pages([
        {"id": "U_other", "login": "other"}, {"id": "U_worker", "login": OWNER},
    ], 1)
    commands.connections[REPO, 1, "projectItems"] = connection_pages([
        {"id": "PVTI_other", "project": {"id": "PVT_other"}},
        {"id": "PVTI_correct", "project": {"id": PROJECT}},
    ], 1)
    commands.connections[REPO, 1, "closedByPullRequestsReferences"] = connection_pages([
        pr_node(10), pr_node(11, state="MERGED", repo="outside/repo"),
    ], 1)
    issue = github.issue(ref)
    assert issue.blockers == blockers
    assert issue.assignees == ("other", OWNER)
    assert issue.project_ids == ("PVT_other", PROJECT)
    assert [pr.number for pr in issue.pull_requests] == [10, 11]
    assert issue.pull_requests[1].repo == "outside/repo"
    queries = " ".join(arg for call in commands.calls for arg in call if arg.startswith("query="))
    assert "includeClosedPrs: true" in queries
    assert "includeArchived: true" in queries
    assert sum("cursor=cursor-1" in call for call in commands.calls) == 3


@pytest.mark.parametrize("reason,completed", [("COMPLETED", True), ("NOT_PLANNED", False), ("DUPLICATE", False)])
def test_blockers_can_be_outside_queue_and_closed_is_not_always_completed(github, commands, reason, completed):
    ref = commands.add_issue(42, repo="outside/private", assignee="other", project=None,
                             state="CLOSED", reason=reason, prs=(pr_node(state="MERGED"),))
    issue = github.issue(ref)
    assert issue.completed is completed
    assert issue.project_ids == ()


@pytest.mark.parametrize("field", ["stateReason", "body", "title", "issueDependenciesSummary", "id"])
def test_missing_required_issue_metadata_fails_closed(github, commands, field):
    ref = commands.add_issue()
    del commands.issues[REPO, 1][field]
    with pytest.raises(OrchestratorError):
        github.issue(ref)


@pytest.mark.parametrize("reason", [None, "UNKNOWN", [], {}])
def test_closed_issue_with_unknown_reason_fails_closed(github, commands, reason):
    ref = commands.add_issue(state="CLOSED", reason=reason)
    with pytest.raises(OrchestratorError, match="stateReason"):
        github.issue(ref)


@pytest.mark.parametrize("damage", ["missing_count", "missing_page_info", "truncated", "null_node", "null_project",
                                     "duplicate", "no_cursor", "repeated_cursor", "changing_count"])
def test_incomplete_project_membership_fails_closed(github, commands, damage):
    ref = commands.add_issue()
    pages = commands.connections[REPO, 1, "projectItems"]
    page = pages[0]
    if damage == "missing_count":
        del page["totalCount"]
    elif damage == "missing_page_info":
        del page["pageInfo"]
    elif damage == "truncated":
        page["totalCount"] = 2
    elif damage == "null_node":
        page["nodes"] = [None]
    elif damage == "null_project":
        page["nodes"][0]["project"] = None
    elif damage == "duplicate":
        page["nodes"] *= 2
        page["totalCount"] = 2
    elif damage == "no_cursor":
        page["totalCount"] = 2
        page["pageInfo"] = {"hasNextPage": True, "endCursor": None}
    else:
        page["totalCount"] = 3
        page["pageInfo"]["hasNextPage"] = True
        second = copy.deepcopy(page)
        second["nodes"][0]["id"] = "PVTI_next"
        if damage == "changing_count":
            second["totalCount"] = 4
        pages.append(second)
    with pytest.raises(OrchestratorError):
        github.issue(ref)


@pytest.mark.parametrize("damage", ["missing_dependency", "null_dependency", "duplicate_dependency", "not_pages"])
def test_incomplete_native_dependencies_fail_closed(github, commands, damage):
    ref = commands.add_issue(blockers=(IssueRef("outside/repo", 2),))
    pages = commands.dependencies[REPO, 1]
    if damage == "missing_dependency":
        pages[0] = []
    elif damage == "null_dependency":
        pages[0] = [None]
    elif damage == "duplicate_dependency":
        pages[0] *= 2
    else:
        commands.dependencies[REPO, 1] = pages[0]
    with pytest.raises(OrchestratorError):
        github.issue(ref)


def test_inaccessible_issue_and_partial_graphql_error_fail_closed(github, commands):
    with pytest.raises(OrchestratorError):
        github.issue(IssueRef("outside/private", 99))
    ref = commands.add_issue()
    commands.graphql_errors = [{"message": "Resource not accessible by integration"}]
    with pytest.raises(OrchestratorError, match="GraphQL error"):
        github.issue(ref)


@pytest.mark.parametrize("operation", ["queue", "dependencies"])
def test_api_error_is_not_an_empty_result(github, commands, operation):
    ref = commands.add_issue()

    def fail(args):
        if any(("issues?" if operation == "queue" else "dependencies/blocked_by?") in arg for arg in args):
            raise CommandError(["gh", *args], 1, "HTTP 403")

    commands.before = fail
    with pytest.raises(CommandError, match="HTTP 403"):
        github.queue() if operation == "queue" else github.issue(ref)


def test_invalid_json_fails_closed(github, commands, monkeypatch):
    monkeypatch.setattr(commands, "run", lambda *args, **kwargs: "not JSON")
    with pytest.raises(OrchestratorError, match="invalid JSON"):
        github.viewer()


@pytest.mark.parametrize("kind", ["users", "orgs"])
def test_resolve_project_uses_explicit_owner_and_number(github, commands, kind):
    url = f"https://github.com/{kind}/project-owner/projects/7"
    commands.project["url"] = url
    assert github.resolve_project(url + "/views/2?pane=info") == commands.project
    assert commands.calls[-1] == ["gh", "project", "view", "7", "--owner", "project-owner", "--format", "json"]


@pytest.mark.parametrize("url", ["http://github.com/orgs/acme/projects/7", "https://evil.test/orgs/acme/projects/7",
                                 "https://github.com.evil.test/orgs/acme/projects/7",
                                 "https://github.com/acme/projects/7", "https://github.com/orgs/acme/projects/0"])
def test_resolve_project_rejects_other_hosts_and_invalid_urls(github, commands, url):
    with pytest.raises(OrchestratorError):
        github.resolve_project(url)
    assert commands.calls == []


def test_resolve_project_rejects_mismatched_project(github, commands):
    with pytest.raises(OrchestratorError, match="project URL"):
        github.resolve_project("https://github.com/users/worker/projects/8")


def test_viewer_uses_only_argument_arrays(github, commands):
    assert github.viewer() == OWNER
    assert commands.calls[-1] == ["gh", "api", "--hostname", "github.com", "user"]


def test_create_issue_assigns_owner_links_explicit_project_and_uses_database_dependency_ids(github, commands):
    blocker = IssueRef("outside/repo", 9)
    commands.add_issue(blockers=(blocker,))
    created = github.create_issue("A title", "A body", (blocker, blocker))
    assert created.ref == IssueRef(REPO, 1)
    assert ["gh", "issue", "create", "--repo", "github.com/acme/app", "--title", "A title",
            "--body", "A body", "--assignee", OWNER] in commands.calls
    assert ["gh", "project", "item-add", "7", "--owner", "acme", "--url", created.ref.url,
            "--format", "json"] in commands.calls
    writes = [call for call in commands.calls if "POST" in call]
    assert len(writes) == 1
    assert "issue_id=1009" in writes[0]  # Global numeric ID, not issue number 9.
    assert commands.calls.index(writes[0]) > next(i for i, call in enumerate(commands.calls) if "item-add" in call)


@pytest.mark.parametrize("failed_step", ["item-add", "POST"])
def test_post_creation_failure_preserves_issue_url_and_does_not_retry(github, commands, failed_step):
    commands.add_issue(blockers=(IssueRef("outside/repo", 9),))

    def fail(args):
        if failed_step in args:
            raise CommandError(["gh", *args], 1, "HTTP 403")

    commands.before = fail
    with pytest.raises(OrchestratorError, match=r"Created https://github.com/acme/app/issues/1"):
        github.create_issue("Title", "Body", (IssueRef("outside/repo", 9),))
    assert sum(call[1:3] == ["issue", "create"] for call in commands.calls) == 1


def test_inaccessible_blocker_prevents_issue_creation(github, commands):
    def fail(args):
        if "repos/outside/private/issues/9" in args:
            raise CommandError(["gh", *args], 1, "HTTP 404")

    commands.before = fail
    with pytest.raises(CommandError):
        github.create_issue("Title", "Body", (IssueRef("outside/private", 9),))
    assert not any(call[1:3] == ["issue", "create"] for call in commands.calls)


def test_create_issue_verifies_membership_after_write(github, commands):
    commands.add_issue(project="PVT_other")
    with pytest.raises(OrchestratorError, match="Created https://github.com/acme/app/issues/1"):
        github.create_issue("Title", "Body")


def test_issue_identity_must_match_requested_reference(github, commands):
    ref = commands.add_issue()
    commands.issues[REPO, 1]["url"] = IssueRef("other/repo", 1).url
    with pytest.raises(OrchestratorError, match="identity"):
        github.issue(ref)


def test_inaccessible_merged_commit_fails_closed(github, commands):
    node = pr_node(state="MERGED")
    node["mergeCommit"] = None
    ref = commands.add_issue(prs=(node,))
    with pytest.raises(OrchestratorError, match="commit"):
        github.issue(ref)
