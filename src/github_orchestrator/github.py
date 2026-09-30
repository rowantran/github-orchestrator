"""GitHub.com adapter using gh's credentials and native issue relationships."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode, urlsplit

from .domain import Issue, IssueRef, OrchestratorError, PullRequest, validate_repo
from .process import Commands

_PROJECT_PATH = re.compile(r"/(users|orgs)/([A-Za-z0-9-]+)/projects/([1-9][0-9]*)(?:/views/[1-9][0-9]*)?/?")
_PR_URL = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)")
_PAGE = "totalCount pageInfo { hasNextPage endCursor }"
_PR_FIELDS = """
    id number url state merged baseRefName headRefName
    mergeCommit { oid } repository { nameWithOwner } headRepository { nameWithOwner }
"""


def _check(condition: bool, detail: str) -> None:
    if not condition:
        raise OrchestratorError(f"Missing, inaccessible, or inconsistent GitHub metadata: {detail}")


def _object(value: Any, detail: str) -> dict:
    _check(isinstance(value, dict), detail)
    return value


def _text(data: dict, key: str, *, empty: bool = False) -> str:
    value = data.get(key)
    _check(isinstance(value, str) and (empty or bool(value.strip())), key)
    return value


def _integer(data: dict, key: str, minimum: int = 0) -> int:
    value = data.get(key)
    _check(type(value) is int and value >= minimum, key)
    return value


def _project_url(url: str) -> tuple[str, str, str]:
    parsed = urlsplit(url)
    match = _PROJECT_PATH.fullmatch(parsed.path)
    if parsed.scheme != "https" or parsed.netloc != "github.com" or not match:
        raise OrchestratorError("Use a https://github.com/users/OWNER/projects/N or /orgs/OWNER/projects/N URL.")
    return match[1], match[2], match[3]


class GitHub:
    def __init__(self, repo: str, project_id: str, owner: str, commands: Commands | None = None):
        self.repo = validate_repo(repo)
        # An empty project ID is useful while resolving initial configuration.
        _check(isinstance(project_id, str), "project ID")
        _check(isinstance(owner, str) and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*", owner)), "owner login")
        self.project_id, self.owner = project_id, owner
        self.commands = commands if commands is not None else Commands()

    def _run(self, args: list[str]) -> str:
        # Forward the environment without inspecting credentials. Project commands
        # have no --hostname option; do not let GH_HOST select another service.
        return self.commands.run(["gh", *args], env=dict(os.environ, GH_HOST="github.com"))

    def _json(self, args: list[str]) -> Any:
        try:
            return json.loads(self._run(args))
        except (ValueError, TypeError) as exc:
            raise OrchestratorError("GitHub returned invalid JSON; no success assumed.") from exc

    def _api(self, endpoint: str, *args: str) -> Any:
        return self._json(["api", "--hostname", "github.com", endpoint, *args])

    def _graphql(self, query: str, **variables: Any) -> dict:
        args = ["-f", f"query={query}"]
        for key, value in variables.items():
            if value is not None:
                args.extend(["-F" if type(value) is int else "-f", f"{key}={value}"])
        response = _object(self._api("graphql", *args), "GraphQL response")
        if response.get("errors"):
            raise OrchestratorError(f"GitHub GraphQL error: {json.dumps(response['errors'])[:2000]}")
        return _object(response.get("data"), "GraphQL data")

    def _rest_pages(self, endpoint: str) -> list[dict]:
        pages = self._api(endpoint, "--paginate", "--slurp")
        _check(isinstance(pages, list) and bool(pages), "REST pagination")
        result = []
        for page in pages:
            _check(isinstance(page, list), "REST page")
            result.extend(_object(node, "REST item") for node in page)
        return result

    def _connection(self, fetch: Callable[[str | None], dict]) -> list[dict]:
        """Page one connection explicitly, rejecting partial or changing results."""
        result: list[dict] = []
        cursor = None
        cursors: set[str] = set()
        ids: set[str] = set()
        expected = None
        while True:
            connection = _object(fetch(cursor), "connection")
            total = _integer(connection, "totalCount")
            if expected is None:
                expected = total
            _check(total == expected, "connection changed during pagination; retry")
            nodes = connection.get("nodes")
            info = _object(connection.get("pageInfo"), "pageInfo")
            _check(isinstance(nodes, list), "connection nodes")
            _check(type(info.get("hasNextPage")) is bool and "endCursor" in info, "pageInfo")
            for node in nodes:
                node = _object(node, "connection node")
                identifier = _text(node, "id")
                _check(identifier not in ids, "duplicate connection node")
                ids.add(identifier)
                result.append(node)
            _check(len(result) <= expected, "connection count")
            if not info["hasNextPage"]:
                _check(len(result) == expected, "truncated connection")
                return result
            cursor = _text(info, "endCursor")
            _check(bool(nodes) and cursor not in cursors and len(result) < expected, "pagination did not advance")
            cursors.add(cursor)

    def _project(self) -> dict:
        _check(bool(self.project_id.strip()), "explicit project ID is required")
        data = self._graphql("""
            query($id: ID!) { node(id: $id) {
                ... on ProjectV2 { id url title }
            } }
        """, id=self.project_id)
        project = _object(data.get("node"), "project (check project access and gh scopes)")
        _check(_text(project, "id") == self.project_id, "project ID")
        _project_url(_text(project, "url"))
        _text(project, "title")
        return project

    def resolve_project(self, url: str) -> dict[str, str]:
        kind, owner, number = _project_url(url)
        data = _object(self._json([
            "project", "view", number, "--owner", owner, "--format", "json",
        ]), "project")
        result = {key: _text(data, key) for key in ("id", "url", "title")}
        actual_kind, actual_owner, actual_number = _project_url(result["url"])
        _check((actual_kind, actual_owner.lower(), actual_number) == (kind, owner.lower(), number), "project URL")
        return result

    def viewer(self) -> str:
        return _text(_object(self._api("user"), "viewer"), "login")

    @staticmethod
    def _rest_ref(data: dict) -> IssueRef:
        _check("pull_request" not in data, "expected an issue, not a pull request")
        ref = IssueRef.parse(_text(data, "html_url"))
        _check(ref.number == _integer(data, "number", 1), "issue number")
        return ref

    def _issue_data(self, ref: IssueRef, fields: str, cursor: str | None = None) -> dict:
        owner, name = ref.repo.split("/")
        # Only connection queries declare the cursor; GraphQL rejects unused variables.
        declaration = ", $cursor: String" if "$cursor" in fields else ""
        query = (f"query($owner: String!, $name: String!, $number: Int!{declaration}) {{ "
                 "repository(owner: $owner, name: $name) { issue(number: $number) { "
                 f"id number url repository {{ nameWithOwner }} {fields} " + "} } }")
        data = self._graphql(query, owner=owner, name=name, number=ref.number, cursor=cursor)
        repository = _object(data.get("repository"), ref.repo)
        issue = _object(repository.get("issue"), ref.url)
        _text(issue, "id")
        actual = IssueRef.parse(_text(issue, "url"))
        _check(actual.key == ref.key and _integer(issue, "number", 1) == ref.number, "issue identity")
        repo = _text(_object(issue.get("repository"), "issue repository"), "nameWithOwner")
        _check(repo.lower() == ref.repo.lower(), "issue repository")
        return issue

    def _issue_connection(self, ref: IssueRef, field: str, selection: str, extra: str = "") -> list[dict]:
        fields = f"{field}(first: 100, after: $cursor{extra}) {{ {_PAGE} nodes {{ {selection} }} }}"
        return self._connection(lambda cursor: self._issue_data(ref, fields, cursor).get(field))

    def queue(self) -> list[Issue]:
        self._project()  # An inaccessible project must not look like an empty queue.
        query = urlencode({"state": "open", "assignee": self.owner, "per_page": 100})
        candidates = self._rest_pages(f"repos/{self.repo}/issues?{query}")
        result = []
        seen: set[str] = set()
        for candidate in candidates:
            if "pull_request" in candidate:
                continue
            ref = self._rest_ref(candidate)
            if ref.repo.lower() != self.repo.lower():
                continue
            _check(ref.key not in seen, "duplicate issue in paginated queue")
            seen.add(ref.key)
            assignees = candidate.get("assignees")
            _check(isinstance(assignees, list), "issue assignees")
            logins = [_text(_object(a, "assignee"), "login").lower() for a in assignees]
            state = _text(candidate, "state").upper()
            _check(state in {"OPEN", "CLOSED"}, "issue state")
            if self.owner.lower() not in logins or state != "OPEN":
                continue
            issue = self.issue(ref)
            if (issue.state == "OPEN" and self.project_id in issue.project_ids
                    and self.owner.lower() in {login.lower() for login in issue.assignees}):
                result.append(issue)
        return sorted(result, key=lambda issue: (issue.ref.repo.lower(), issue.ref.number))

    def issue(self, ref: IssueRef) -> Issue:
        # Deliberately not restricted to this queue: blockers can be anywhere.
        data = self._issue_data(ref, """
            title body state stateReason issueDependenciesSummary { totalBlockedBy }
        """)
        state = _text(data, "state")
        _check(state in {"OPEN", "CLOSED"}, "issue state")
        _check("stateReason" in data, "issue stateReason")
        reason = data["stateReason"]
        _check(reason in (None, "COMPLETED", "NOT_PLANNED", "REOPENED", "DUPLICATE"), "issue stateReason")
        _check(state != "CLOSED" or reason is not None, "closed issue stateReason")
        assignees = self._issue_connection(ref, "assignees", "id login")
        items = self._issue_connection(ref, "projectItems", "id project { id }", ", includeArchived: true")
        projects = [_text(_object(item.get("project"), "item project"), "id") for item in items]
        _check(projects.count(self.project_id) <= 1, "duplicate project membership")
        closing = self._issue_connection(ref, "closedByPullRequestsReferences", _PR_FIELDS, ", includeClosedPrs: true")
        blockers = [self._rest_ref(node) for node in self._rest_pages(
            f"repos/{ref.repo}/issues/{ref.number}/dependencies/blocked_by?per_page=100"
        )]
        count = _integer(_object(data.get("issueDependenciesSummary"), "dependency summary"), "totalBlockedBy")
        _check(len(blockers) == len({blocker.key for blocker in blockers}) == count,
               "incomplete or inaccessible blocking dependencies")
        return Issue(
            ref=ref, title=_text(data, "title"), body=_text(data, "body", empty=True),
            state=state, state_reason=reason, assignees=tuple(_text(a, "login") for a in assignees),
            project_ids=tuple(projects), blockers=tuple(blockers),
            pull_requests=tuple(self._pull_request(node) for node in closing),
        )

    def create_issue(self, title: str, body: str, blockers: tuple[IssueRef, ...] = ()) -> Issue:
        project = self._project()
        _, project_owner, project_number = _project_url(project["url"])
        dependency_ids: dict[str, int] = {}
        for blocker in blockers:
            data = _object(self._api(f"repos/{blocker.repo}/issues/{blocker.number}"), blocker.url)
            _check(self._rest_ref(data).key == blocker.key, "blocking issue identity")
            dependency_ids[blocker.key] = _integer(data, "id", 1)
        url = self._run([
            "issue", "create", "--repo", f"github.com/{self.repo}",
            "--title", title, "--body", body, "--assignee", self.owner,
        ]).strip()
        ref = IssueRef.parse(url)
        _check(ref.repo.lower() == self.repo.lower(), f"created issue repository: {url}")
        try:
            item = _object(self._json([
                "project", "item-add", project_number, "--owner", project_owner,
                "--url", ref.url, "--format", "json",
            ]), "created project item")
            _text(item, "id")
            for identifier in dependency_ids.values():
                self._api(f"repos/{ref.repo}/issues/{ref.number}/dependencies/blocked_by",
                          "--method", "POST", "-F", f"issue_id={identifier}")
            issue = self.issue(ref)
            _check(self.project_id in issue.project_ids, "created issue project membership")
            _check(self.owner.lower() in {a.lower() for a in issue.assignees}, "created issue assignee")
            _check(set(dependency_ids) <= {b.key for b in issue.blockers}, "created issue dependencies")
            return issue
        except OrchestratorError as exc:
            raise OrchestratorError(
                f"Created {ref.url}, but setup is incomplete: {exc}. Repair this issue; do not recreate it."
            ) from exc

    @staticmethod
    def _pull_request(data: dict) -> PullRequest:
        _text(data, "id")
        url = _text(data, "url")
        match = _PR_URL.fullmatch(url)
        _check(match is not None, "pull request URL must be on github.com")
        repo = _text(_object(data.get("repository"), "pull request repository"), "nameWithOwner")
        number = _integer(data, "number", 1)
        _check(match[1].lower() == repo.lower() and int(match[2]) == number, "pull request identity")
        state = _text(data, "state")
        merged = data.get("merged")
        _check(state in {"OPEN", "CLOSED", "MERGED"} and type(merged) is bool, "pull request state")
        _check(merged == (state == "MERGED"), "pull request merged state")
        _check("mergeCommit" in data, "pull request mergeCommit")
        commit = data["mergeCommit"]
        oid = _text(_object(commit, "merge commit"), "oid") if commit is not None else None
        _check(not merged or oid is not None, "merged pull request commit")
        return PullRequest(number=number, url=url, state=state, merged=merged,
                           base=_text(data, "baseRefName"), head=_text(data, "headRefName"),
                           merge_commit=oid, repo=repo)
