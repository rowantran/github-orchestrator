#!/usr/bin/env python3
"""Strict, file-backed gh fixture. Unknown commands fail; nothing contacts GitHub."""
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT = Path(os.environ["GHO_E2E_FIXTURE"])
ARGS = sys.argv[1:]
STATE_PATH = ROOT / "state.json"


def log(name, value):
    with (ROOT / name).open("a") as stream:
        stream.write(json.dumps(value) + "\n")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def save(state):
    temporary = STATE_PATH.with_suffix(".new")
    temporary.write_text(json.dumps(state))
    temporary.replace(STATE_PATH)


def connection(nodes):
    return {"nodes": nodes, "totalCount": len(nodes),
            "pageInfo": {"hasNextPage": False, "endCursor": None}}


def params(args):
    require(len(args) % 2 == 0, "unpaired parameters")
    result = {}
    for option, value in zip(args[::2], args[1::2]):
        require(option in ("-f", "-F"), f"unexpected option {option}")
        key, separator, value = value.partition("=")
        require(separator and key not in result, "invalid or duplicate parameter")
        result[key] = value
    return result


def issue(state, repo, number):
    require(f"{repo}#{number}" in state["issues"], f"unknown issue {repo}#{number}")
    return state["issues"][f"{repo}#{number}"]


def identity(spec):
    return {"id": f'I_{spec["repo"]}_{spec["number"]}', "number": spec["number"],
            "url": f'https://github.com/{spec["repo"]}/issues/{spec["number"]}',
            "repository": {"nameWithOwner": spec["repo"]}}


def rest_issue(spec):
    return {"number": spec["number"], "html_url": identity(spec)["url"],
            "state": spec["state"].lower(), "assignees": [{"login": x} for x in spec["assignees"]]}


def batched_issues(state, query, values):
    require(set(values) == {"owner", "name"}, "unexpected batch parameters")
    require(values["owner"] + "/" + values["name"] == "acme/app", "unknown batch repository")
    aliases = re.findall(r"issue_(\d+): issue\(number: (\d+)\)", query)
    require(1 <= len(aliases) <= 50, "unexpected batch size")
    require(all(alias == number for alias, number in aliases), "batch alias identity mismatch")
    require(len(set(aliases)) == len(aliases), "duplicate batch alias")
    membership = "projectItems(first: 100, includeArchived: true) { totalCount pageInfo { hasNextPage endCursor } nodes { id project { id } } }"
    pr_fields = "id number url state merged isDraft baseRefName headRefName mergeCommit { oid } repository { nameWithOwner } headRepository { nameWithOwner }"
    hydration = (
        "title body state stateReason issueDependenciesSummary { totalBlockedBy } "
        "assignees(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { id login } } "
        "closedByPullRequestsReferences(first: 100, includeClosedPrs: true) { "
        "totalCount pageInfo { hasNextPage endCursor } nodes { " + pr_fields + " } }"
    )
    labels = "labels(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { id name } }"
    fields = membership if "projectItems(" in query else labels if "labels(" in query else hydration
    selections = " ".join(f"issue_{number}: issue(number: {number}) {{ id number url repository {{ nameWithOwner }} {fields} }}"
                          for _, number in aliases)
    expected = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { " + selections + " } }"
    require(" ".join(query.split()) == expected, "unknown batched issue query")
    result = {}
    for alias, number in aliases:
        spec = issue(state, "acme/app", int(number))
        node = identity(spec)
        if fields == membership:
            node["projectItems"] = connection([{"id": f'PVTI_{number}', "project": {"id": "PVT_queue"}}] if spec["project"] else [])
        elif fields == labels:
            require(spec["project"], "reading batch labels outside the Project")
            node["labels"] = connection([{"id": "L_" + label, "name": label} for label in spec["labels"]])
        else:
            require(spec["project"], "hydrating an issue outside the Project")
            node.update({"title": spec["title"], "body": spec["body"], "state": spec["state"],
                         "stateReason": spec["reason"],
                         "issueDependenciesSummary": {"totalBlockedBy": len(spec["blockers"])},
                         "assignees": connection([{"id": "U_" + login, "login": login} for login in spec["assignees"]]),
                         "closedByPullRequestsReferences": connection(spec["closing_prs"])})
        result["issue_" + alias] = node
    return {"data": {"repository": result}}


def batched_pull_requests(state, query, values):
    aliases = re.findall(r"pr_(\d+): pullRequests\(headRefName: \$branch_(\d+),", query)
    require(1 <= len(aliases) <= 50, "unexpected PR batch size")
    require(aliases == [(str(index), str(index)) for index in range(len(aliases))], "unexpected PR aliases")
    keys = ["branch_" + index for index, _ in aliases]
    require(set(values) == {"owner", "name", *keys}, "unexpected PR batch parameters")
    require(values["owner"] + "/" + values["name"] == "acme/app", "unknown PR repository")
    pr_fields = "id number url state merged isDraft baseRefName headRefName mergeCommit { oid } repository { nameWithOwner } headRepository { nameWithOwner }"
    declarations = "".join(", $" + key + ": String!" for key in keys)
    selections = " ".join(
        "pr_" + index + ": pullRequests(headRefName: $branch_" + index + ", states: [OPEN, CLOSED, MERGED], first: 100) { "
        "totalCount pageInfo { hasNextPage endCursor } nodes { " + pr_fields + " } }"
        for index, _ in aliases)
    expected = "query($owner: String!, $name: String!" + declarations + ") { repository(owner: $owner, name: $name) { " + selections + " } }"
    require(" ".join(query.split()) == expected, "unknown batched PR query")
    result = {}
    for index, _ in aliases:
        branch = values["branch_" + index]
        match = re.fullmatch(r"worker/gh-([1-9][0-9]*)", branch)
        require(match is not None, "unknown PR branch")
        require(issue(state, "acme/app", int(match[1]))["project"], "PR branch outside fixture Project")
        result["pr_" + index] = connection(state["branch_prs"].get(branch, []))
    return {"data": {"repository": result}}


def graphql(state, arguments):
    values = params(arguments)
    query = values.pop("query")
    require(query.lstrip().startswith("query("), "mutations are forbidden")
    require("cursor" not in values, "unexpected pagination cursor")
    if re.search(r"\bissue_\d+:", query):
        return batched_issues(state, query, values)
    if re.search(r"\bpr_\d+:", query):
        return batched_pull_requests(state, query, values)
    if "issue(number: $number)" in query:
        require(set(values) == {"owner", "name", "number"}, "unexpected issue parameters")
        spec = issue(state, values["owner"] + "/" + values["name"], int(values["number"]))
        result = identity(spec)
        selections = [field for field in ("assignees", "projectItems", "closedByPullRequestsReferences", "labels")
                      if field + "(" in query]
        if selections:
            require(len(selections) == 1, "unexpected combined connection query")
            field = selections[0]
            require("first: 100, after: $cursor" in query, "unexpected connection pagination")
            if field == "assignees":
                nodes = [{"id": "U_" + login, "login": login} for login in spec["assignees"]]
            elif field == "projectItems":
                require("includeArchived: true" in query, "archived project tasks must be included")
                nodes = [{"id": f'PVTI_{spec["number"]}', "project": {"id": "PVT_queue"}}] if spec["project"] else []
            elif field == "closedByPullRequestsReferences":
                require("includeClosedPrs: true" in query, "closed PRs must be included")
                nodes = spec["closing_prs"]
            else:
                nodes = [{"id": "L_" + label, "name": label} for label in spec["labels"]]
            result[field] = connection(nodes)
        else:
            require("title body state stateReason issueDependenciesSummary { totalBlockedBy }" in query,
                    "unknown issue fields")
            result.update({"title": spec["title"], "body": spec["body"], "state": spec["state"],
                           "stateReason": spec["reason"],
                           "issueDependenciesSummary": {"totalBlockedBy": len(spec["blockers"])}})
        return {"data": {"repository": {"issue": result}}}
    if "pullRequests(headRefName: $branch," in query:
        require(set(values) == {"owner", "name", "branch"}, "unexpected branch parameters")
        require(values["owner"] + "/" + values["name"] == "acme/app", "unknown PR repository")
        branch = re.fullmatch(r"worker/gh-([1-9][0-9]*)", values["branch"])
        require(branch is not None, "unknown PR branch")
        require(issue(state, "acme/app", int(branch[1]))["project"], "PR branch outside fixture Project")
        require("states: [OPEN, CLOSED, MERGED]" in query or "states: [OPEN]" in query,
                "unknown pull request states")
        prs = state["branch_prs"].get(values["branch"], [])
        if "states: [OPEN]" in query:
            prs = [pr for pr in prs if pr["state"] == "OPEN"]
        return {"data": {"repository": {"pullRequests": connection(prs)}}}
    raise ValueError("unknown GraphQL query")


def respond(state):
    require(os.environ.get("GH_HOST") == "github.com", "GH_HOST not pinned")
    if ARGS == ["project", "view", "7", "--owner", "acme", "--format", "json"]:
        return {"id": "PVT_queue", "url": "https://github.com/orgs/acme/projects/7", "title": "Test queue"}
    require(ARGS[:3] == ["api", "--hostname", "github.com"], "unknown gh command")
    require(len(ARGS) >= 4, "missing API endpoint")
    endpoint, extra = ARGS[3], ARGS[4:]
    if endpoint == "graphql":
        return graphql(state, extra)
    if endpoint in ("repos/acme/app/issues?state=all&per_page=100",
                    "repos/acme/app/issues?state=open&assignee=worker&per_page=100"):
        require(extra == ["--paginate", "--slurp"], "unpaginated issues")
        specs = [spec for spec in state["issues"].values() if spec["repo"] == "acme/app"]
        if "state=open" in endpoint:
            specs = [spec for spec in specs if spec["state"] == "OPEN" and "worker" in spec["assignees"]]
        return [[rest_issue(spec) for spec in specs]]
    dependency = re.fullmatch(r"repos/([^/]+/[^/]+)/issues/(\d+)/dependencies/blocked_by\?per_page=100", endpoint)
    if dependency:
        require(extra == ["--paginate", "--slurp"], "unpaginated dependencies")
        spec = issue(state, dependency[1], int(dependency[2]))
        return [[rest_issue(state["issues"][key]) for key in spec["blockers"]]]
    if endpoint == "repos/acme/app/labels?per_page=100":
        require(extra == ["--paginate", "--slurp"], "unpaginated labels")
        return [[{"name": name} for name in state["labels"]]]
    if endpoint == "repos/acme/app/labels":
        require(extra[:2] == ["--method", "POST"], "unknown label operation")
        values = params(extra[2:])
        require(set(values) == {"name", "color"} and values["color"] == "5319e7", "unexpected label fields")
        require(values["name"].startswith("gho:workstream:"), "non-workstream label write")
        require(values["name"] not in state["labels"], "duplicate label creation")
        state["labels"].append(values["name"])
        save(state)
        return {"name": values["name"]}
    labels = re.fullmatch(r"repos/acme/app/issues/(\d+)/labels(?:/(.+))?", endpoint)
    if labels:
        spec = issue(state, "acme/app", int(labels[1]))
        if labels[2] is None:
            require(extra[:2] == ["--method", "POST"], "only additive label writes are allowed")
            values = params(extra[2:])
            require(set(values) == {"labels[]"}, "unexpected label update fields")
            label = values["labels[]"]
            require(label in state["labels"] and label.startswith("gho:workstream:"), "unknown label")
            if label not in spec["labels"]:
                spec["labels"].append(label)
        else:
            require(extra == ["--method", "DELETE"], "unknown membership delete")
            label = unquote(labels[2])
            require(label.startswith("gho:workstream:") and label in spec["labels"], "unknown membership")
            spec["labels"].remove(label)
        save(state)
        return [{"name": name} for name in spec["labels"]]
    raise ValueError("unknown REST endpoint: " + endpoint)


log("gh-calls.jsonl", ARGS)
try:
    if (ROOT / "fail-gh").exists():
        print("Fixture GitHub unavailable (intentional refresh failure)", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(respond(json.loads(STATE_PATH.read_text()))))
except Exception as error:
    log("rejected.jsonl", {"args": ARGS, "error": str(error)})
    print(f"Rejected fake gh call: {error}", file=sys.stderr)
    sys.exit(87)
