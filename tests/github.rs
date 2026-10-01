//! GitHub adapter tests against a command-level fixture: no subprocesses, credentials, or GitHub writes.

use std::cell::{RefCell, RefMut};
use std::collections::HashMap;

use github_orchestrator::domain::{IssueRef, IssueState, PullRequestState, StateReason};
use github_orchestrator::github::GitHub;
use github_orchestrator::process::{Cmd, Runner};
use github_orchestrator::{Error, Result};
use serde_json::{Value, json};

const REPO: &str = "acme/app";
const PROJECT: &str = "PVT_queue";
const PROJECT_URL: &str = "https://github.com/orgs/acme/projects/7";
const OWNER: &str = "worker";
const BRANCH: &str = "work/issue-1";

fn issue_ref(repo: &str, number: u64) -> IssueRef {
    IssueRef::new(repo, number).unwrap()
}

fn connection_pages(nodes: Vec<Value>, size: usize) -> Vec<Value> {
    let chunks: Vec<Vec<Value>> =
        if nodes.is_empty() { vec![vec![]] } else { nodes.chunks(size).map(<[Value]>::to_vec).collect() };
    let count = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| {
            json!({
                "totalCount": nodes.len(), "nodes": chunk,
                "pageInfo": {"hasNextPage": i + 1 < count, "endCursor": format!("cursor-{}", i + 1)},
            })
        })
        .collect()
}

fn rest_issue(number: u64, repo: &str, assignee: &str) -> Value {
    json!({"id": 1000 + number, "number": number, "html_url": issue_ref(repo, number).url(),
           "state": "open", "assignees": [{"login": assignee}]})
}

fn pr_node(number: u64, state: &str, repo: &str) -> Value {
    json!({
        "id": format!("PR_{repo}_{number}"), "number": number, "url": format!("https://github.com/{repo}/pull/{number}"),
        "state": state, "merged": state == "MERGED", "isDraft": false, "baseRefName": "main", "headRefName": BRANCH,
        "mergeCommit": if state == "MERGED" { json!({"oid": "a".repeat(40)}) } else { Value::Null },
        "repository": {"nameWithOwner": repo}, "headRepository": {"nameWithOwner": repo},
    })
}

struct Spec {
    number: u64,
    repo: &'static str,
    assignee: &'static str,
    project: Option<&'static str>,
    blockers: Vec<IssueRef>,
    prs: Vec<Value>,
    state: &'static str,
    reason: Value,
}

fn spec(number: u64) -> Spec {
    Spec {
        number,
        repo: REPO,
        assignee: OWNER,
        project: Some(PROJECT),
        blockers: vec![],
        prs: vec![],
        state: "OPEN",
        reason: Value::Null,
    }
}

type Key = (String, u64);
/// Fails a command before the fixture answers it.
type Hook = Box<dyn Fn(&[String]) -> Option<Error>>;

struct State {
    calls: Vec<Vec<String>>,
    issues: HashMap<Key, Value>,
    connections: HashMap<(String, u64, &'static str), Vec<Value>>,
    /// A list of pages per issue; a `Value` so tests can damage the shape.
    dependencies: HashMap<Key, Value>,
    /// Open pull request connection pages by head branch; `None` makes the repository inaccessible.
    branch_prs: Option<HashMap<String, Vec<Value>>>,
    queue_pages: Value,
    project_pages: Option<Vec<Value>>,
    project_node: Value,
    label_pages: Value,
    label_write_response: Option<Value>,
    project: Value,
    before: Hook,
    graphql_errors: Vec<Value>,
    raw_output: Option<String>,
}

/// Project enumeration returns only identity and type data, never issue bodies or PR history.
fn project_pages(state: &State, size: usize) -> Vec<Value> {
    let mut items = Vec::new();
    for ((repo, number, field), pages) in &state.connections {
        if *field != "projectItems" {
            continue;
        }
        for item in pages.iter().flat_map(|page| page["nodes"].as_array().unwrap()) {
            if item["project"]["id"] != PROJECT {
                continue;
            }
            let content = state.issues.get(&(repo.clone(), *number)).map_or(Value::Null, |issue| {
                let mut content = json!({"__typename": "Issue"});
                for field in ["id", "number", "url", "repository"] {
                    if let Some(value) = issue.get(field) {
                        content[field] = value.clone();
                    }
                }
                content
            });
            items.push(json!({
                "id": item["id"], "type": "ISSUE", "isArchived": item.get("isArchived").unwrap_or(&json!(false)),
                "content": content,
            }));
        }
    }
    items.sort_by_key(|item| item["content"]["number"].as_u64().unwrap_or_default());
    connection_pages(items, size)
}

struct Fixture(RefCell<State>);

impl Fixture {
    fn new() -> Self {
        Fixture(RefCell::new(State {
            calls: vec![],
            issues: HashMap::new(),
            connections: HashMap::new(),
            dependencies: HashMap::new(),
            branch_prs: Some(HashMap::new()),
            queue_pages: json!([[]]),
            project_pages: None,
            project_node: json!({"__typename": "ProjectV2", "id": PROJECT}),
            label_pages: json!([[]]),
            label_write_response: None,
            project: json!({"id": PROJECT, "url": PROJECT_URL, "title": "Queue"}),
            before: Box::new(|_| None),
            graphql_errors: vec![],
            raw_output: None,
        }))
    }

    fn state(&self) -> RefMut<'_, State> {
        self.0.borrow_mut()
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.0.borrow().calls.clone()
    }

    fn github(&self) -> GitHub<'_> {
        GitHub::new(REPO, PROJECT_URL, OWNER, self).unwrap()
    }

    fn add_issue(&self, spec: Spec) -> IssueRef {
        let reference = issue_ref(spec.repo, spec.number);
        let key = (spec.repo.to_lowercase(), spec.number);
        let mut state = self.state();
        state.issues.insert(key.clone(), json!({
            "id": format!("I_{}_{}", spec.repo, spec.number), "number": spec.number, "url": reference.url(),
            "repository": {"nameWithOwner": spec.repo}, "title": format!("Issue {}", spec.number), "body": "Details",
            "state": spec.state, "stateReason": spec.reason,
            "issueDependenciesSummary": {"totalBlockedBy": spec.blockers.len()},
        }));
        let (repo, number) = key.clone();
        state.connections.insert((repo.clone(), number, "labels"), connection_pages(vec![], 100));
        state.connections.insert(
            (repo.clone(), number, "assignees"),
            connection_pages(vec![json!({"id": "U_worker", "login": spec.assignee})], 100),
        );
        let items = spec.project.map(|p| json!({"id": format!("PVTI_{number}"), "project": {"id": p}}));
        state
            .connections
            .insert((repo.clone(), number, "projectItems"), connection_pages(items.into_iter().collect(), 100));
        state
            .connections
            .insert((repo.clone(), number, "closedByPullRequestsReferences"), connection_pages(spec.prs, 100));
        let blockers: Vec<Value> = spec.blockers.iter().map(|b| rest_issue(b.number(), b.repo(), OWNER)).collect();
        state.dependencies.insert(key, json!([blockers]));
        reference
    }

    fn respond(&self, args: &[String]) -> String {
        let mut state = self.0.borrow_mut();
        if args[..3] == ["api", "--hostname", "github.com"] {
            let endpoint = args[3].as_str();
            if endpoint == "graphql" {
                let params: HashMap<&str, &str> = args[4..].iter().filter_map(|a| a.split_once('=')).collect();
                let query = params["query"];
                let data = if query.contains("node(id: $project)") {
                    assert_eq!(params["project"], PROJECT);
                    assert!(query.contains("archivedStates: [ARCHIVED, NOT_ARCHIVED]"));
                    let cursor = params.get("cursor").copied().unwrap_or("cursor-0");
                    let page: usize = cursor.split('-').nth(1).unwrap().parse().unwrap();
                    let pages = state.project_pages.clone().unwrap_or_else(|| project_pages(&state, 100));
                    let mut node = state.project_node.clone();
                    if node.is_object() {
                        node["items"] = pages[page].clone();
                    }
                    json!({"node": node})
                } else if query.contains("issue_") {
                    let repo = format!("{}/{}", params["owner"], params["name"]).to_lowercase();
                    let pattern = regex::Regex::new(r"(issue_[0-9]+): issue\(number: ([0-9]+)\)").unwrap();
                    let mut repository = serde_json::Map::new();
                    for captures in pattern.captures_iter(query) {
                        let number: u64 = captures[2].parse().unwrap();
                        let mut issue = state.issues.get(&(repo.clone(), number)).cloned().unwrap_or(Value::Null);
                        if issue.is_object() {
                            for field in ["assignees", "projectItems", "closedByPullRequestsReferences", "labels"] {
                                if query.contains(&format!("{field}(")) {
                                    issue[field] = state.connections[&(repo.clone(), number, field)][0].clone();
                                }
                            }
                        }
                        repository.insert(captures[1].into(), issue);
                    }
                    assert!(!repository.is_empty(), "empty issue batch: {query}");
                    json!({"repository": repository})
                } else if query.contains("pr_0:") {
                    match &state.branch_prs {
                        None => json!({"repository": null}),
                        Some(prs) => {
                            let mut repository = serde_json::Map::new();
                            for (key, branch) in &params {
                                if let Some(index) = key.strip_prefix("branch_") {
                                    let pages =
                                        prs.get(*branch).cloned().unwrap_or_else(|| connection_pages(vec![], 100));
                                    repository.insert(format!("pr_{index}"), pages[0].clone());
                                }
                            }
                            json!({"repository": repository})
                        }
                    }
                } else if query.contains("issue(number:") {
                    let repo = format!("{}/{}", params["owner"], params["name"]).to_lowercase();
                    let number: u64 = params["number"].parse().unwrap();
                    let mut issue = state.issues.get(&(repo.clone(), number)).cloned().unwrap_or(Value::Null);
                    if issue.is_object() {
                        for field in ["assignees", "projectItems", "closedByPullRequestsReferences", "labels"] {
                            if query.contains(&format!("{field}(")) {
                                let cursor = params.get("cursor").copied().unwrap_or("cursor-0");
                                let page: usize = cursor.split('-').nth(1).unwrap().parse().unwrap();
                                issue[field] = state.connections[&(repo.clone(), number, field)][page].clone();
                            }
                        }
                    }
                    json!({"repository": {"issue": issue}})
                } else if query.contains("pullRequests(headRefName: $branch, states:") {
                    assert_eq!(format!("{}/{}", params["owner"], params["name"]), REPO);
                    match &state.branch_prs {
                        None => json!({"repository": null}),
                        Some(prs) => {
                            let cursor = params.get("cursor").copied().unwrap_or("cursor-0");
                            let page: usize = cursor.split('-').nth(1).unwrap().parse().unwrap();
                            let pages =
                                prs.get(params["branch"]).cloned().unwrap_or_else(|| connection_pages(vec![], 100));
                            json!({"repository": {"pullRequests": pages[page]}})
                        }
                    }
                } else {
                    panic!("Unexpected GraphQL: {query}");
                };
                let mut response = json!({"data": data});
                if !state.graphql_errors.is_empty() {
                    response["errors"] = json!(state.graphql_errors);
                }
                return response.to_string();
            }
            if endpoint == "user" {
                return json!({"login": OWNER}).to_string();
            }
            let parts: Vec<&str> = endpoint.split('/').collect();
            assert_eq!(parts[0], "repos");
            let repo = format!("{}/{}", parts[1], parts[2]).to_lowercase();
            let paginated = args.contains(&"--paginate".into()) && args.contains(&"--slurp".into());
            if parts[3].starts_with("labels?") {
                assert!(paginated && endpoint.contains("per_page=100"));
                return state.label_pages.to_string();
            }
            if parts[3] == "labels" {
                assert!(args.contains(&"POST".into()));
                let name = args.iter().find_map(|arg| arg.strip_prefix("name=")).unwrap();
                let label = json!({"name": name, "color": "5319e7", "description": null});
                state.label_pages[0].as_array_mut().unwrap().push(label.clone());
                return state.label_write_response.clone().unwrap_or(label).to_string();
            }
            if parts[3].starts_with("issues?") {
                assert!(paginated && endpoint.contains("per_page=100"));
                return state.queue_pages.to_string();
            }
            let number: u64 = parts[4].parse().unwrap();
            if parts.get(5) == Some(&"labels") {
                let key = (repo, number, "labels");
                let mut labels: Vec<Value> = state.connections[&key]
                    .iter()
                    .flat_map(|page| page["nodes"].as_array().unwrap().iter().cloned())
                    .collect();
                if args.contains(&"POST".into()) {
                    let name = args.iter().find_map(|arg| arg.strip_prefix("labels[]=")).unwrap();
                    labels.push(json!({"id": format!("L_{name}"), "name": name}));
                } else {
                    assert!(args.contains(&"DELETE".into()));
                    let decoded: String =
                        parts[6].split('%').skip(1).map(|hex| u8::from_str_radix(hex, 16).unwrap() as char).collect();
                    labels.retain(|label| !label["name"].as_str().unwrap().eq_ignore_ascii_case(&decoded));
                }
                state.connections.insert(key, connection_pages(labels.clone(), 100));
                return state.label_write_response.clone().unwrap_or(json!(labels)).to_string();
            }
            assert!(paginated && endpoint.contains("per_page=100"));
            return state.dependencies[&(repo, number)].to_string();
        }
        match (args[0].as_str(), args[1].as_str()) {
            ("project", "view") => state.project.to_string(),
            ("project", "item-add") => json!({"id": "PVTI_1"}).to_string(),
            ("issue", "create") => format!("{}\n", issue_ref(REPO, 1).url()),
            _ => panic!("Unexpected command: {args:?}"),
        }
    }
}

impl Runner for Fixture {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        assert_eq!(cmd.argv[0], "gh");
        assert!(cmd.env.contains(&("GH_HOST".into(), "github.com".into())));
        let args = cmd.argv[1..].to_vec();
        self.state().calls.push(cmd.argv.clone());
        if let Some(error) = (self.0.borrow().before)(&args) {
            return Err(error);
        }
        if let Some(output) = self.0.borrow().raw_output.clone() {
            return Ok(output);
        }
        Ok(self.respond(&args))
    }
}

fn http_error(args: &[String], status: &str) -> Error {
    let _ = args;
    Error::Command { program: "gh".into(), code: Some(1), stderr: format!("HTTP {status}") }
}

fn fails<T: std::fmt::Debug>(result: Result<T>, needle: &str) {
    let error = result.expect_err("expected an error");
    assert!(error.to_string().contains(needle), "{error:?} should mention {needle:?}");
}

#[test]
fn queue_pages_and_exact_repository_project_and_assignee() {
    let f = Fixture::new();
    f.add_issue(spec(1));
    f.add_issue(Spec { project: Some("PVT_other"), ..spec(2) });
    f.add_issue(Spec { assignee: "someone-else", ..spec(3) });
    f.add_issue(spec(4));
    let mut pull_request = rest_issue(10, REPO, OWNER);
    pull_request["pull_request"] = json!({"url": "ignored"});
    f.state().queue_pages = json!([
        [
            rest_issue(1, REPO, OWNER),
            rest_issue(2, REPO, OWNER),
            rest_issue(20, "other/repo", OWNER),
            rest_issue(30, REPO, "other")
        ],
        [rest_issue(3, REPO, OWNER), rest_issue(4, REPO, OWNER), pull_request],
    ]);
    let numbers: Vec<u64> = f.github().queue().unwrap().iter().map(|i| i.reference.number()).collect();
    assert_eq!(numbers, [1, 4]);
    let request = f.calls().into_iter().find(|call| call.iter().any(|a| a.contains("issues?"))).unwrap();
    assert!(request.contains(&"repos/acme/app/issues?state=open&assignee=worker&per_page=100".into()));
}

#[test]
fn queue_ignores_closed_issues_and_checks_live_assignment() {
    let f = Fixture::new();
    f.add_issue(Spec { state: "CLOSED", reason: json!("COMPLETED"), ..spec(1) });
    f.add_issue(Spec { assignee: "other", ..spec(2) });
    let mut closed = rest_issue(3, REPO, OWNER);
    closed["state"] = json!("closed");
    f.state().queue_pages = json!([[rest_issue(1, REPO, OWNER), rest_issue(2, REPO, OWNER), closed]]);
    assert!(f.github().queue().unwrap().is_empty());
}

#[test]
fn queue_is_case_insensitive_for_github_names() {
    let f = Fixture::new();
    f.add_issue(Spec { repo: "ACME/APP", assignee: "WORKER", ..spec(1) });
    f.state().queue_pages = json!([[rest_issue(1, "ACME/APP", "WORKER")]]);
    let queued = f.github().queue().unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].assignees, ["WORKER"]);
    assert_eq!(queued[0].reference.url(), "https://github.com/acme/app/issues/1");
    // Request casing must not matter.
    let again = f.github().issue(&issue_ref("AcMe/ApP", 1)).unwrap();
    assert_eq!(again.reference, queued[0].reference);
}

#[test]
fn empty_queue_still_requires_project_access() {
    for project in [Value::Null, json!({}), json!({"id": "PVT_wrong", "url": "x", "title": "x"})] {
        let f = Fixture::new();
        f.state().project = project.clone();
        assert!(f.github().queue().is_err(), "{project}");
    }
}

#[test]
fn issue_paginates_all_native_relationships() {
    let f = Fixture::new();
    let blockers: Vec<IssueRef> = (1..=101).map(|n| issue_ref("outside/repo", n)).collect();
    let reference = f.add_issue(Spec { blockers: blockers.clone(), ..spec(1) });
    {
        let mut state = f.state();
        let page =
            |range: &[IssueRef]| range.iter().map(|b| rest_issue(b.number(), b.repo(), OWNER)).collect::<Vec<_>>();
        state.dependencies.insert((REPO.into(), 1), json!([page(&blockers[..100]), page(&blockers[100..])]));
        state.connections.insert(
            (REPO.into(), 1, "assignees"),
            connection_pages(
                vec![json!({"id": "U_other", "login": "other"}), json!({"id": "U_worker", "login": OWNER})],
                1,
            ),
        );
        state.connections.insert(
            (REPO.into(), 1, "projectItems"),
            connection_pages(
                vec![
                    json!({"id": "PVTI_other", "project": {"id": "PVT_other"}}),
                    json!({"id": "PVTI_correct", "project": {"id": PROJECT}}),
                ],
                1,
            ),
        );
        state.connections.insert(
            (REPO.into(), 1, "closedByPullRequestsReferences"),
            connection_pages(vec![pr_node(10, "OPEN", REPO), pr_node(11, "MERGED", "outside/repo")], 1),
        );
    }
    let issue = f.github().issue(&reference).unwrap();
    assert_eq!(issue.blockers, blockers);
    assert_eq!(issue.assignees, ["other", OWNER]);
    assert_eq!(issue.project_ids, ["PVT_other", PROJECT]);
    let numbers: Vec<u64> = issue.pull_requests.iter().map(|pr| pr.number).collect();
    assert_eq!(numbers, [10, 11]);
    assert_eq!(issue.pull_requests[1].repo, "outside/repo");
    assert_eq!(issue.pull_requests[1].state, PullRequestState::Merged);
    let calls = f.calls();
    let queries: String = calls.iter().flatten().filter(|a| a.starts_with("query=")).cloned().collect();
    assert!(queries.contains("includeClosedPrs: true"));
    assert!(queries.contains("includeArchived: true"));
    assert_eq!(calls.iter().filter(|call| call.contains(&"cursor=cursor-1".into())).count(), 3);
}

#[test]
fn blockers_can_be_outside_queue_and_closed_is_not_always_completed() {
    for (reason, completed) in [("COMPLETED", true), ("NOT_PLANNED", false), ("DUPLICATE", false)] {
        let f = Fixture::new();
        let reference = f.add_issue(Spec {
            repo: "outside/private",
            assignee: "other",
            project: None,
            state: "CLOSED",
            reason: json!(reason),
            prs: vec![pr_node(10, "MERGED", REPO)],
            ..spec(42)
        });
        let issue = f.github().issue(&reference).unwrap();
        assert_eq!(issue.completed(), completed, "{reason}");
        assert_eq!(issue.state, IssueState::Closed);
        assert!(issue.project_ids.is_empty());
    }
}

#[test]
fn missing_required_issue_metadata_fails_closed() {
    for field in ["stateReason", "body", "title", "issueDependenciesSummary", "id"] {
        let f = Fixture::new();
        let reference = f.add_issue(spec(1));
        f.state().issues.get_mut(&(REPO.into(), 1)).unwrap().as_object_mut().unwrap().remove(field);
        assert!(f.github().issue(&reference).is_err(), "{field}");
    }
}

#[test]
fn closed_issue_with_unknown_reason_fails_closed() {
    for reason in [Value::Null, json!("UNKNOWN"), json!([]), json!({})] {
        let f = Fixture::new();
        let reference = f.add_issue(Spec { state: "CLOSED", reason: reason.clone(), ..spec(1) });
        assert!(f.github().issue(&reference).is_err(), "{reason}");
    }
    let f = Fixture::new();
    let reference = f.add_issue(Spec { state: "CLOSED", ..spec(1) });
    fails(f.github().issue(&reference), "stateReason");
}

#[test]
fn incomplete_project_membership_fails_closed() {
    let damages = [
        "missing_count",
        "missing_page_info",
        "truncated",
        "null_node",
        "null_project",
        "duplicate",
        "no_cursor",
        "repeated_cursor",
        "changing_count",
    ];
    for damage in damages {
        let f = Fixture::new();
        let reference = f.add_issue(spec(1));
        {
            let mut state = f.state();
            let pages = state.connections.get_mut(&(REPO.into(), 1, "projectItems")).unwrap();
            let page = &mut pages[0];
            match damage {
                "missing_count" => drop(page.as_object_mut().unwrap().remove("totalCount")),
                "missing_page_info" => drop(page.as_object_mut().unwrap().remove("pageInfo")),
                "truncated" => page["totalCount"] = json!(2),
                "null_node" => page["nodes"] = json!([null]),
                "null_project" => page["nodes"][0]["project"] = Value::Null,
                "duplicate" => {
                    let node = page["nodes"][0].clone();
                    page["nodes"] = json!([node.clone(), node]);
                    page["totalCount"] = json!(2);
                }
                "no_cursor" => {
                    page["totalCount"] = json!(2);
                    page["pageInfo"] = json!({"hasNextPage": true, "endCursor": null});
                }
                _ => {
                    page["totalCount"] = json!(3);
                    page["pageInfo"]["hasNextPage"] = json!(true);
                    let mut second = page.clone();
                    second["nodes"][0]["id"] = json!("PVTI_next");
                    if damage == "changing_count" {
                        second["totalCount"] = json!(4);
                    }
                    pages.push(second);
                }
            }
        }
        assert!(f.github().issue(&reference).is_err(), "{damage}");
    }
}

#[test]
fn incomplete_native_dependencies_fail_closed() {
    for damage in ["missing_dependency", "null_dependency", "duplicate_dependency", "not_pages"] {
        let f = Fixture::new();
        let reference = f.add_issue(Spec { blockers: vec![issue_ref("outside/repo", 2)], ..spec(1) });
        {
            let mut state = f.state();
            let pages = state.dependencies.get_mut(&(REPO.into(), 1)).unwrap();
            let first = pages[0].clone();
            match damage {
                "missing_dependency" => pages[0] = json!([]),
                "null_dependency" => pages[0] = json!([null]),
                "duplicate_dependency" => pages[0] = json!([first[0], first[0]]),
                _ => *pages = first,
            }
        }
        assert!(f.github().issue(&reference).is_err(), "{damage}");
    }
}

#[test]
fn inaccessible_issue_and_partial_graphql_error_fail_closed() {
    let f = Fixture::new();
    assert!(f.github().issue(&issue_ref("outside/private", 99)).is_err());
    let reference = f.add_issue(spec(1));
    f.state().graphql_errors = vec![json!({"message": "Resource not accessible by integration"})];
    fails(f.github().issue(&reference), "GraphQL error");
}

#[test]
fn api_error_is_not_an_empty_result() {
    for operation in ["queue", "dependencies"] {
        let f = Fixture::new();
        let reference = f.add_issue(spec(1));
        let needle = if operation == "queue" { "issues?" } else { "dependencies/blocked_by?" };
        f.state().before =
            Box::new(move |args| args.iter().any(|a| a.contains(needle)).then(|| http_error(args, "403")));
        let result = if operation == "queue" {
            f.github().queue().map(|_| ())
        } else {
            f.github().issue(&reference).map(|_| ())
        };
        let error = result.unwrap_err();
        assert!(matches!(error, Error::Command { .. }) && error.to_string().contains("HTTP 403"), "{operation}");
    }
}

#[test]
fn invalid_json_fails_closed() {
    let f = Fixture::new();
    f.state().raw_output = Some("not JSON".into());
    fails(f.github().resolve_project("https://github.com/orgs/acme/projects/7"), "invalid JSON");
}

#[test]
fn resolve_project_uses_explicit_owner_and_number() {
    for kind in ["users", "orgs"] {
        let f = Fixture::new();
        let url = format!("https://github.com/{kind}/project-owner/projects/7");
        f.state().project["url"] = json!(url);
        let project = f.github().resolve_project(&format!("{url}/views/2?pane=info")).unwrap();
        assert_eq!(
            (project.id.as_str(), project.url.as_str(), project.title.as_str()),
            (PROJECT, url.as_str(), "Queue")
        );
        assert_eq!(
            f.calls().last().unwrap(),
            &["gh", "project", "view", "7", "--owner", "project-owner", "--format", "json"]
        );
    }
}

#[test]
fn resolve_project_rejects_other_hosts_and_invalid_urls() {
    for url in [
        "http://github.com/orgs/acme/projects/7",
        "https://evil.test/orgs/acme/projects/7",
        "https://github.com.evil.test/orgs/acme/projects/7",
        "https://github.com:443/orgs/acme/projects/7",
        "https://github.com/acme/projects/7",
        "https://github.com/orgs/acme/projects/0",
    ] {
        let f = Fixture::new();
        assert!(f.github().resolve_project(url).is_err(), "{url}");
        assert!(f.calls().is_empty());
    }
}

#[test]
fn configured_project_is_looked_up_once_and_must_be_a_project_url() {
    let f = Fixture::new();
    f.add_issue(spec(1));
    f.state().queue_pages = json!([[rest_issue(1, REPO, OWNER)]]);
    let github = f.github();
    assert_eq!(github.queue().unwrap().len(), 1);
    github.issue(&issue_ref(REPO, 1)).unwrap();
    let views = f.calls().iter().filter(|call| call[1..3] == ["project", "view"]).count();
    assert_eq!(views, 1);
    assert!(GitHub::new(REPO, "https://github.com/acme/app", OWNER, &f).is_err());
}

#[test]
fn resolve_project_rejects_mismatched_project() {
    let f = Fixture::new();
    fails(f.github().resolve_project("https://github.com/users/worker/projects/8"), "project URL");
}

#[test]
fn create_issue_assigns_owner_links_blockers_through_gh_and_adds_explicit_project() {
    let f = Fixture::new();
    let (outside, local) = (issue_ref("outside/repo", 9), issue_ref(REPO, 3));
    f.add_issue(Spec { blockers: vec![outside.clone(), local.clone()], ..spec(1) });
    let blockers = [outside.clone(), local, outside];
    let created = f.github().create_issue("A title", "A body", &blockers).unwrap();
    assert_eq!(created.reference, issue_ref(REPO, 1));
    let calls = f.calls();
    // Each blocker once, as a full URL so cross-repository blockers resolve.
    let expected = [
        "gh",
        "issue",
        "create",
        "--repo",
        "github.com/acme/app",
        "--title",
        "A title",
        "--body",
        "A body",
        "--assignee",
        OWNER,
        "--blocked-by",
        "https://github.com/acme/app/issues/3",
        "--blocked-by",
        "https://github.com/outside/repo/issues/9",
    ];
    assert!(calls.iter().any(|call| call == &expected), "{calls:?}");
    let url = created.reference.url();
    let add = ["gh", "project", "item-add", "7", "--owner", "acme", "--url", url.as_str(), "--format", "json"];
    assert!(calls.iter().any(|call| call == &add));
    // gh writes the dependencies; gho only reads them back.
    assert!(!calls.iter().flatten().any(|arg| arg == "POST"));
}

#[test]
fn create_issue_without_blockers_passes_no_blocked_by_flag() {
    let f = Fixture::new();
    f.add_issue(spec(1));
    f.github().create_issue("Title", "Body", &[]).unwrap();
    assert!(!f.calls().iter().flatten().any(|arg| arg == "--blocked-by"));
}

#[test]
fn post_creation_failure_preserves_issue_url_and_does_not_retry() {
    let f = Fixture::new();
    f.add_issue(Spec { blockers: vec![issue_ref("outside/repo", 9)], ..spec(1) });
    f.state().before = Box::new(|args| args.iter().any(|a| a == "item-add").then(|| http_error(args, "403")));
    fails(
        f.github().create_issue("Title", "Body", &[issue_ref("outside/repo", 9)]),
        "Created https://github.com/acme/app/issues/1",
    );
    assert_eq!(f.calls().iter().filter(|call| call[1..3] == ["issue", "create"]).count(), 1);
}

#[test]
fn missing_blocker_link_after_creation_is_reported_for_repair() {
    let f = Fixture::new();
    f.add_issue(spec(1)); // GitHub reports no blockers on the created issue.
    fails(
        f.github().create_issue("Title", "Body", &[issue_ref("outside/repo", 9)]),
        "Created https://github.com/acme/app/issues/1, but setup is incomplete",
    );
}

#[test]
fn failed_gh_create_with_blockers_warns_the_issue_may_exist() {
    let f = Fixture::new();
    f.state().before = Box::new(|args| (args[..2] == ["issue", "create"]).then(|| http_error(args, "404")));
    let error = f.github().create_issue("Title", "Body", &[issue_ref("outside/private", 9)]).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("HTTP 404") && message.contains("may have created the issue"), "{message}");
    assert!(message.contains("\"Title\"") && message.contains("do not create it twice"), "{message}");
    assert_eq!(f.calls().iter().filter(|call| call[1..3] == ["issue", "create"]).count(), 1);
}

#[test]
fn failed_gh_create_without_blockers_returns_the_gh_error() {
    let f = Fixture::new();
    f.state().before = Box::new(|args| (args[..2] == ["issue", "create"]).then(|| http_error(args, "422")));
    let error = f.github().create_issue("Title", "Body", &[]).unwrap_err();
    assert!(matches!(error, Error::Command { .. }), "{error:?}");
}

#[test]
fn create_issue_verifies_membership_after_write() {
    let f = Fixture::new();
    f.add_issue(Spec { project: Some("PVT_other"), ..spec(1) });
    fails(f.github().create_issue("Title", "Body", &[]), "Created https://github.com/acme/app/issues/1");
}

#[test]
fn issue_identity_must_match_requested_reference() {
    let f = Fixture::new();
    let reference = f.add_issue(spec(1));
    f.state().issues.get_mut(&(REPO.into(), 1)).unwrap()["url"] = json!(issue_ref("other/repo", 1).url());
    fails(f.github().issue(&reference), "identity");
}

#[test]
fn inaccessible_merged_commit_fails_closed() {
    let f = Fixture::new();
    let mut node = pr_node(10, "MERGED", REPO);
    node["mergeCommit"] = Value::Null;
    let reference = f.add_issue(Spec { prs: vec![node], ..spec(1) });
    fails(f.github().issue(&reference), "commit");
}

#[test]
fn state_reasons_decode() {
    let f = Fixture::new();
    let reference = f.add_issue(Spec { state: "CLOSED", reason: json!("NOT_PLANNED"), ..spec(1) });
    assert_eq!(f.github().issue(&reference).unwrap().state_reason, Some(StateReason::NotPlanned));
}

fn branch_pr(number: u64, head: &str, head_repo: Option<&str>) -> Value {
    let mut pr = pr_node(number, "OPEN", REPO);
    pr["headRefName"] = json!(head);
    pr["headRepository"] = head_repo.map_or(Value::Null, |repo| json!({"nameWithOwner": repo}));
    pr
}

#[test]
fn open_pull_request_is_found_by_head_branch_in_this_repository() {
    let f = Fixture::new();
    let prs = vec![
        branch_pr(7, "worker/gh-1", Some("stranger/app")), // a fork's branch with the same name
        branch_pr(8, "worker/gh-1", None),                 // deleted fork
        branch_pr(9, "worker/gh-1", Some("ACME/App")),
    ];
    f.state().branch_prs = Some(HashMap::from([("worker/gh-1".into(), connection_pages(prs, 2))]));
    let pr = f.github().open_pull_request("worker/gh-1").unwrap().unwrap();
    assert_eq!((pr.number, pr.head.as_str(), pr.state, pr.draft), (9, "worker/gh-1", PullRequestState::Open, false));
    assert_eq!(f.github().open_pull_request("worker/gh-2").unwrap(), None);
}

#[test]
fn draft_pull_requests_are_marked_as_drafts() {
    let f = Fixture::new();
    let mut pr = branch_pr(9, "worker/gh-1", Some(REPO));
    pr["isDraft"] = json!(true);
    f.state().branch_prs = Some(HashMap::from([("worker/gh-1".into(), connection_pages(vec![pr], 100))]));
    assert!(f.github().open_pull_request("worker/gh-1").unwrap().unwrap().draft);
}

#[test]
fn several_open_pull_requests_from_one_branch_are_an_error() {
    let f = Fixture::new();
    let prs = vec![branch_pr(8, "worker/gh-1", Some(REPO)), branch_pr(9, "worker/gh-1", Some(REPO))];
    f.state().branch_prs = Some(HashMap::from([("worker/gh-1".into(), connection_pages(prs, 100))]));
    fails(f.github().open_pull_request("worker/gh-1"), "More than one open pull request from worker/gh-1");
}

#[test]
fn open_pull_request_lookup_fails_closed() {
    let f = Fixture::new();
    f.state().branch_prs = None;
    fails(f.github().open_pull_request("worker/gh-1"), "pull requests");

    let f = Fixture::new();
    let prs = vec![branch_pr(9, "worker/gh-other", Some(REPO))];
    f.state().branch_prs = Some(HashMap::from([("worker/gh-1".into(), connection_pages(prs, 100))]));
    fails(f.github().open_pull_request("worker/gh-1"), "pull request for worker/gh-1");
}

fn set_labels(f: &Fixture, number: u64, labels: &[&str], page_size: usize) {
    let nodes = labels.iter().map(|name| json!({"id": format!("L_{name}"), "name": name})).collect();
    f.state().connections.insert((REPO.into(), number, "labels"), connection_pages(nodes, page_size));
}

#[test]
fn workstreams_list_all_pages_including_empty_and_independent_names() {
    let f = Fixture::new();
    f.state().label_pages = json!([
        [{"name": "bug"}, {"name": "gho:workstream:project-a/feature-1"}],
        [{"name": "gho:workstream:empty"}, {"name": "gho:workstream:project-a"}]
    ]);
    assert_eq!(f.github().workstreams().unwrap(), ["empty", "project-a", "project-a/feature-1"]);
    assert_eq!(f.calls().len(), 1); // No issue lookup: empty workstreams are labels too.
}

#[test]
fn workstream_creation_is_idempotent_without_overwriting_label_metadata() {
    let f = Fixture::new();
    let existing = json!({"name": "gho:workstream:project-a", "color": "123456", "description": "Keep this"});
    f.state().label_pages = json!([[existing.clone()]]);
    let github = f.github();
    github.create_workstream("project-a").unwrap();
    assert_eq!(f.state().label_pages, json!([[existing]]));
    github.create_workstream("PROJECT-A").unwrap();
    assert!(!f.calls().iter().flatten().any(|arg| arg == "POST" || arg == "PATCH" || arg == "--force"));
    github.create_workstream("project-b").unwrap();
    github.create_workstream("project-b").unwrap();
    assert_eq!(github.workstreams().unwrap(), ["project-a", "project-b"]);
    assert_eq!(f.calls().iter().filter(|args| args.contains(&"POST".into())).count(), 1);
}

#[test]
fn workstream_updates_preserve_unrelated_labels_and_other_memberships() {
    let f = Fixture::new();
    let reference = f.add_issue(spec(1));
    f.state().label_pages = json!([[{"name": "gho:workstream:project-a/feature-1"}]]);
    set_labels(&f, 1, &["bug", "gho:workstream:project-a", "gho:workstream:other"], 1);
    let github = f.github();
    github.add_to_workstream("project-a/feature-1", &[reference.clone(), reference.clone()]).unwrap();
    assert_eq!(
        github.issue_labels(&reference).unwrap(),
        ["bug", "gho:workstream:other", "gho:workstream:project-a", "gho:workstream:project-a/feature-1"]
    );
    github.add_to_workstream("project-a/feature-1", std::slice::from_ref(&reference)).unwrap();
    github.remove_from_workstream("project-a/feature-1", std::slice::from_ref(&reference)).unwrap();
    github.remove_from_workstream("project-a/feature-1", std::slice::from_ref(&reference)).unwrap();
    assert_eq!(github.issue_labels(&reference).unwrap(), ["bug", "gho:workstream:other", "gho:workstream:project-a"]);
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|args| args.contains(&"POST".into())).count(), 1);
    let deletes: Vec<_> = calls.iter().filter(|args| args.contains(&"DELETE".into())).collect();
    assert_eq!(deletes.len(), 1);
    assert!(deletes[0][4].contains("%2F"));
    assert!(!calls.iter().flatten().any(|arg| arg == "PUT"));
}

#[test]
fn workstream_updates_prevalidate_all_references_and_names_before_writes() {
    let f = Fixture::new();
    for add in [true, false] {
        let github = f.github();
        let change = |name, refs: &[IssueRef]| {
            if add { github.add_to_workstream(name, refs) } else { github.remove_from_workstream(name, refs) }
        };
        fails(change("project-a", &[issue_ref(REPO, 1), issue_ref("outside/repo", 2)]), "cannot change");
        fails(change("--force", &[issue_ref(REPO, 1)]), "Invalid workstream");
        assert!(f.calls().is_empty());
    }
    fails(f.github().add_to_workstream("missing", &[issue_ref(REPO, 1)]), "Unknown workstream");
    assert!(!f.calls().iter().flatten().any(|arg| arg == "POST"));
}

#[test]
fn workstream_partial_failure_reports_successes_failed_issue_and_no_later_writes() {
    let f = Fixture::new();
    let refs: Vec<_> = (1..=3).map(|n| f.add_issue(spec(n))).collect();
    f.state().label_pages = json!([[{"name": "gho:workstream:a"}]]);
    f.state().before = Box::new(|args| {
        (args.contains(&"POST".into()) && args.iter().any(|arg| arg.contains("issues/2/labels")))
            .then(|| http_error(args, "403"))
    });
    let github = f.github();
    let error = github.add_to_workstream("a", &refs).unwrap_err().to_string();
    for needle in ["HTTP 403", &refs[0].url(), &refs[1].url(), "remaining issues were not attempted"] {
        assert!(error.contains(needle), "{error}");
    }
    assert_eq!(github.issue_labels(&refs[0]).unwrap(), ["gho:workstream:a"]);
    assert!(github.issue_labels(&refs[2]).unwrap().is_empty());
}

#[test]
fn workstream_api_failures_and_malformed_labels_are_not_empty_successes() {
    for labels in [
        json!([]),
        json!([null]),
        json!([[null]]),
        json!([[{}]]),
        json!([[{"name":""}]]),
        json!([[{"name":"gho:workstream:"}]]),
        json!([[{"name":"bug"}], [{"name":"BUG"}]]),
    ] {
        let f = Fixture::new();
        f.state().label_pages = labels.clone();
        assert!(f.github().workstreams().is_err(), "{labels}");
    }
    let f = Fixture::new();
    f.state().before = Box::new(|args| Some(http_error(args, "403")));
    fails(f.github().workstreams(), "HTTP 403");
    fails(f.github().create_workstream("a"), "HTTP 403");

    let f = Fixture::new();
    let reference = f.add_issue(spec(1));
    f.state().label_pages = json!([[{"name":"gho:workstream:a"}]]);
    f.state().label_write_response = Some(json!([]));
    fails(f.github().add_to_workstream("a", &[reference]), "membership after update");
}

#[test]
fn workstream_labels_fail_on_truncated_or_inaccessible_connections() {
    let f = Fixture::new();
    let reference = f.add_issue(spec(1));
    set_labels(&f, 1, &["gho:workstream:a", "gho:workstream:b"], 1);
    assert_eq!(f.github().issue_labels(&reference).unwrap(), ["gho:workstream:a", "gho:workstream:b"]);
    f.state().connections.get_mut(&(REPO.into(), 1, "labels")).unwrap()[0]["pageInfo"]["hasNextPage"] = json!(false);
    fails(f.github().issue_labels(&reference), "truncated connection");
}

#[test]
fn project_issues_include_closed_unassigned_and_other_assignees_and_archived_memberships() {
    let f = Fixture::new();
    f.add_issue(spec(1));
    f.add_issue(Spec { state: "CLOSED", reason: json!("COMPLETED"), assignee: "other", ..spec(2) });
    f.add_issue(Spec { project: None, ..spec(3) });
    f.add_issue(Spec { state: "CLOSED", reason: json!("NOT_PLANNED"), ..spec(4) });
    f.state().connections.insert((REPO.into(), 4, "assignees"), connection_pages(vec![], 100));
    f.state().connections.get_mut(&(REPO.into(), 2, "projectItems")).unwrap()[0]["nodes"][0]["isArchived"] =
        json!(true);
    let pages = project_pages(&f.0.borrow(), 2);
    f.state().project_pages = Some(pages);
    let issues = f.github().project_issues().unwrap();
    assert_eq!(issues.iter().map(|i| i.reference.number()).collect::<Vec<_>>(), [1, 2, 4]);
    assert!(issues[1].completed());
    assert!(issues[2].assignees.is_empty());
    assert_eq!(issues[1].assignees, ["other"]);
    let calls = f.calls();
    assert!(!calls.iter().flatten().any(|a| a.contains("issues?state=") || a.contains("projectItems(")));
    assert_eq!(calls.iter().flatten().filter(|a| a.contains("archivedStates: [ARCHIVED, NOT_ARCHIVED]")).count(), 2);
    assert_eq!(issues[1].project_ids, [PROJECT]);
}

#[test]
fn project_listing_only_hydrates_members_without_reading_other_memberships() {
    let f = Fixture::new();
    f.add_issue(spec(1));
    f.add_issue(Spec { project: None, ..spec(2) });
    f.add_issue(Spec { repo: "outside/repo", ..spec(3) });
    assert_eq!(f.github().project_issues().unwrap().len(), 1);
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|call| call.iter().any(|arg| arg.contains("issue_1:"))).count(), 1);
    assert!(!calls.iter().flatten().any(|arg| {
        arg.contains("projectItems(")
            || arg.contains("issue_2:")
            || arg.contains("issue_3:")
            || arg.contains("issues/2/dependencies")
            || arg.contains("issues/3/dependencies")
            || arg.contains("issues?state=")
    }));
}

#[test]
fn project_listing_skips_known_nonissues_and_filters_cross_repository_issues() {
    let f = Fixture::new();
    f.add_issue(spec(1));
    f.add_issue(Spec { repo: "outside/repo", ..spec(2) });
    let mut nodes = project_pages(&f.0.borrow(), 100)[0]["nodes"].as_array().unwrap().clone();
    nodes.extend([
        json!({"id": "PVTI_pr", "type": "PULL_REQUEST", "isArchived": true, "content": {"__typename": "PullRequest"}}),
        json!({"id": "PVTI_draft", "type": "DRAFT_ISSUE", "isArchived": false, "content": {"__typename": "DraftIssue"}}),
    ]);
    f.state().project_pages = Some(connection_pages(nodes, 1));
    let issues = f.github().project_issues().unwrap();
    assert_eq!(issues.iter().map(|issue| issue.reference.number()).collect::<Vec<_>>(), [1]);
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|call| call.iter().any(|arg| arg.contains("node(id: $project)"))).count(), 4);
    assert!(!calls.iter().flatten().any(|arg| arg.contains("pullRequests(") || arg.contains("issue_2:")));
}

#[test]
fn project_listing_validates_project_node_even_when_empty() {
    let f = Fixture::new();
    assert!(f.github().project_issues().unwrap().is_empty());
    for node in [
        Value::Null,
        json!({}),
        json!({"__typename": "Repository", "id": PROJECT}),
        json!({"__typename": "ProjectV2", "id": "PVT_wrong"}),
        json!({"__typename": "ProjectV2", "id": null}),
    ] {
        let f = Fixture::new();
        f.state().project_node = node.clone();
        assert!(f.github().project_issues().is_err(), "{node}");
    }
    let f = Fixture::new();
    f.state().graphql_errors = vec![json!({"message": "partial Project response"})];
    fails(f.github().project_issues(), "GraphQL error");
}

#[test]
fn project_listing_rejects_partial_pages_and_invalid_pagination() {
    for damage in [
        "null_connection",
        "missing_count",
        "missing_nodes",
        "missing_page_info",
        "missing_cursor",
        "truncated",
        "excess",
        "changing_count",
        "no_cursor",
        "blank_cursor",
        "repeated_cursor",
        "empty_page",
        "duplicate_item",
    ] {
        let f = Fixture::new();
        for number in 1..=3 {
            f.add_issue(spec(number));
        }
        let mut pages = project_pages(&f.0.borrow(), 1);
        match damage {
            "null_connection" => pages[0] = Value::Null,
            "missing_count" => {
                pages[0].as_object_mut().unwrap().remove("totalCount");
            }
            "missing_nodes" => {
                pages[0].as_object_mut().unwrap().remove("nodes");
            }
            "missing_page_info" => {
                pages[0].as_object_mut().unwrap().remove("pageInfo");
            }
            "missing_cursor" => {
                pages[0]["pageInfo"].as_object_mut().unwrap().remove("endCursor");
            }
            "truncated" => pages[0]["pageInfo"]["hasNextPage"] = json!(false),
            "excess" => pages[0]["totalCount"] = json!(0),
            "changing_count" => pages[1]["totalCount"] = json!(4),
            "no_cursor" => pages[0]["pageInfo"]["endCursor"] = Value::Null,
            "blank_cursor" => pages[0]["pageInfo"]["endCursor"] = json!(" "),
            "repeated_cursor" => pages[1]["pageInfo"]["endCursor"] = json!("cursor-1"),
            "empty_page" => pages[0]["nodes"] = json!([]),
            _ => pages[1]["nodes"][0]["id"] = pages[0]["nodes"][0]["id"].clone(),
        }
        f.state().project_pages = Some(pages);
        assert!(f.github().project_issues().is_err(), "{damage}");
    }
}

#[test]
fn project_listing_rejects_redaction_malformed_items_and_inconsistent_issue_identities() {
    for damage in [
        "null_item",
        "blank_item_id",
        "missing_archived",
        "null_archived",
        "redacted",
        "unknown_type",
        "missing_content",
        "null_content",
        "unknown_content_type",
        "mismatched_content_type",
        "missing_issue_id",
        "blank_issue_id",
        "wrong_number",
        "zero_number",
        "pr_url",
        "wrong_repo",
        "missing_repository",
        "foreign_inconsistent_issue",
        "duplicate_issue",
        "duplicate_issue_id",
    ] {
        let f = Fixture::new();
        f.add_issue(spec(1));
        f.add_issue(spec(2));
        let mut pages = project_pages(&f.0.borrow(), 1);
        let item = &mut pages[0]["nodes"][0];
        match damage {
            "null_item" => *item = Value::Null,
            "blank_item_id" => item["id"] = json!(" "),
            "missing_archived" => {
                item.as_object_mut().unwrap().remove("isArchived");
            }
            "null_archived" => item["isArchived"] = Value::Null,
            "redacted" => {
                item["type"] = json!("REDACTED");
                item["content"] = Value::Null;
            }
            "unknown_type" => item["type"] = json!("UNKNOWN"),
            "missing_content" => {
                item.as_object_mut().unwrap().remove("content");
            }
            "null_content" => item["content"] = Value::Null,
            "unknown_content_type" => item["content"]["__typename"] = json!("Unknown"),
            "mismatched_content_type" => item["type"] = json!("PULL_REQUEST"),
            "missing_issue_id" => {
                item["content"].as_object_mut().unwrap().remove("id");
            }
            "blank_issue_id" => item["content"]["id"] = json!(" "),
            "wrong_number" => item["content"]["number"] = json!(99),
            "zero_number" => item["content"]["number"] = json!(0),
            "pr_url" => item["content"]["url"] = json!("https://github.com/acme/app/pull/1"),
            "wrong_repo" => item["content"]["repository"]["nameWithOwner"] = json!("outside/repo"),
            "missing_repository" => item["content"]["repository"] = Value::Null,
            "foreign_inconsistent_issue" => item["content"]["url"] = json!("https://github.com/outside/repo/issues/1"),
            "duplicate_issue" => {
                let content = item["content"].clone();
                pages[1]["nodes"][0]["content"] = content;
                pages[1]["nodes"][0]["content"]["id"] = json!("I_duplicate_reference");
            }
            _ => {
                let id = item["content"]["id"].clone();
                pages[1]["nodes"][0]["content"]["id"] = id;
            }
        }
        f.state().project_pages = Some(pages);
        assert!(f.github().project_issues().is_err(), "{damage}");
    }
}

#[test]
fn project_listing_checks_hydrated_identity_against_enumeration() {
    for damage in ["missing_alias", "changed_id", "wrong_number"] {
        let f = Fixture::new();
        f.add_issue(spec(1));
        let pages = project_pages(&f.0.borrow(), 100);
        f.state().project_pages = Some(pages);
        match damage {
            "missing_alias" => {
                f.state().issues.remove(&(REPO.into(), 1));
            }
            "changed_id" => f.state().issues.get_mut(&(REPO.into(), 1)).unwrap()["id"] = json!("I_changed"),
            _ => f.state().issues.get_mut(&(REPO.into(), 1)).unwrap()["number"] = json!(2),
        }
        assert!(f.github().project_issues().is_err(), "{damage}");
    }
}

#[test]
fn project_issue_listing_and_historical_prs_fail_closed() {
    let f = Fixture::new();
    f.state().project = Value::Null;
    assert!(f.github().project_issues().is_err());
    let f = Fixture::new();
    f.add_issue(spec(1));
    let item = project_pages(&f.0.borrow(), 100)[0]["nodes"][0].clone();
    f.state().project_pages = Some(connection_pages(vec![item.clone(), item], 1));
    fails(f.github().project_issues(), "duplicate connection node");
    f.state().branch_prs = None;
    fails(f.github().pull_requests("worker/gh-1"), "pull requests");
}

#[test]
fn branch_lookup_includes_draft_closed_and_merged_stacked_prs_with_pagination() {
    let f = Fixture::new();
    let mut draft = branch_pr(10, "worker/gh-1", Some(REPO));
    draft["isDraft"] = json!(true);
    let mut merged = pr_node(11, "MERGED", REPO);
    merged["headRefName"] = json!("worker/gh-1");
    merged["baseRefName"] = json!("worker/gh-9");
    let mut closed = pr_node(12, "CLOSED", REPO);
    closed["headRefName"] = json!("worker/gh-1");
    f.state().branch_prs =
        Some(HashMap::from([("worker/gh-1".into(), connection_pages(vec![draft, merged, closed], 1))]));
    let prs = f.github().pull_requests("worker/gh-1").unwrap();
    assert_eq!(
        prs.iter().map(|pr| pr.state).collect::<Vec<_>>(),
        [PullRequestState::Open, PullRequestState::Merged, PullRequestState::Closed]
    );
    assert!(prs[0].draft);
    assert_eq!(prs[1].base, "worker/gh-9");
}

struct NoBranches;

impl github_orchestrator::work::Branches for NoBranches {
    fn worktrees(&self) -> Result<std::collections::BTreeMap<String, String>> {
        Ok(Default::default())
    }
    fn branch_exists(&self, _: &str) -> Result<bool> {
        Ok(false)
    }
}

fn dashboard_config() -> github_orchestrator::config::Config {
    github_orchestrator::config::Config {
        repo: REPO.into(),
        owner: OWNER.into(),
        project_url: PROJECT_URL.into(),
        checkout: "/nonexistent".into(),
        base_branch: "main".into(),
        vault: None,
        agents: Default::default(),
    }
}

#[test]
fn snapshot_classifies_full_graph_with_overlaps_completed_data_and_external_blockers() {
    use github_orchestrator::work::State;
    use github_orchestrator::workstreams::snapshot;
    let f = Fixture::new();
    let external = issue_ref("outside/repo", 90);
    f.add_issue(Spec { assignee: "someone-else", ..spec(1) });
    f.add_issue(Spec { blockers: vec![issue_ref(REPO, 1)], ..spec(2) });
    f.add_issue(Spec { state: "CLOSED", reason: json!("COMPLETED"), ..spec(3) });
    f.add_issue(Spec { blockers: vec![external.clone()], ..spec(4) });
    f.add_issue(Spec { repo: "outside/repo", project: None, ..spec(90) });
    f.state().queue_pages = json!([
        [rest_issue(1, REPO, "someone-else"), rest_issue(2, REPO, OWNER)],
        [rest_issue(3, REPO, OWNER), rest_issue(4, REPO, OWNER)]
    ]);
    f.state().label_pages = json!([[{"name":"gho:workstream:a"}, {"name":"gho:workstream:b"}],
        [{"name":"gho:workstream:empty"}, {"name":"gho:workstream:a/feature"}]]);
    set_labels(&f, 1, &["gho:workstream:b"], 1);
    set_labels(&f, 2, &["bug", "gho:workstream:a", "gho:workstream:b"], 1);
    set_labels(&f, 3, &["gho:workstream:a/feature"], 1);
    let review = branch_pr(10, "worker/gh-1", Some(REPO));
    let mut merged = pr_node(30, "MERGED", REPO);
    merged["headRefName"] = json!("worker/gh-3");
    merged["baseRefName"] = json!("worker/gh-1");
    f.state().branch_prs = Some(HashMap::from([
        ("worker/gh-1".into(), connection_pages(vec![review], 100)),
        ("worker/gh-3".into(), connection_pages(vec![merged], 100)),
    ]));
    let snapshot = snapshot(&dashboard_config(), &f.github(), &NoBranches).unwrap();
    assert_eq!(snapshot.workstreams, ["a", "a/feature", "b", "empty"]);
    assert_eq!(snapshot.tasks.len(), 4);
    assert_eq!(snapshot.tasks[1].workstreams, ["a", "b"]);
    assert_eq!(snapshot.tasks[1].entry.state, State::Ready { stack_on: vec![1] });
    assert_eq!(snapshot.tasks[2].workstreams, ["a/feature"]); // No implicit membership in a.
    assert_eq!(snapshot.tasks[2].entry.state, State::Done);
    assert_eq!(snapshot.tasks[2].pull_requests[0].state, PullRequestState::Merged);
    assert_eq!(snapshot.tasks[2].pull_requests[0].base, "worker/gh-1");
    assert_eq!(snapshot.tasks[3].entry.state, State::Blocked);
    assert_eq!(snapshot.tasks[3].entry.blockers[0].repo, "outside/repo");
    assert_eq!(snapshot.tasks[3].entry.blockers[0].branch, None);
    assert_eq!(snapshot.tasks[1].entry.blockers[0].pull_requests.len(), 1);
    let json = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(json["repo"], REPO);
    assert_eq!(json["project_url"], PROJECT_URL);
    assert_eq!(json["tasks"][2]["state"], "done");
    assert!(json["tasks"][2].get("entry").is_none());
    let calls = f.calls();
    // Shared blockers and classification reuse the complete branch lookup, even across workstreams.
    assert_eq!(calls.iter().filter(|call| call.iter().any(|arg| arg.ends_with("=worker/gh-1"))).count(), 1);
    assert!(!calls.iter().flatten().any(|arg| arg.ends_with("=worker/gh-90")));
}

#[test]
fn snapshot_reports_drafts_and_deduplicates_closing_and_branch_pr_links() {
    let f = Fixture::new();
    let mut draft = branch_pr(10, "worker/gh-1", Some(REPO));
    draft["isDraft"] = json!(true);
    f.add_issue(Spec { prs: vec![draft.clone()], ..spec(1) });
    f.state().queue_pages = json!([[rest_issue(1, REPO, OWNER)]]);
    f.state().branch_prs = Some(HashMap::from([("worker/gh-1".into(), connection_pages(vec![draft], 100))]));
    let snapshot = github_orchestrator::workstreams::snapshot(&dashboard_config(), &f.github(), &NoBranches).unwrap();
    assert_eq!(snapshot.tasks[0].entry.state, github_orchestrator::work::State::InProgress);
    assert_eq!(snapshot.tasks[0].pull_requests.len(), 1);
    assert!(snapshot.tasks[0].pull_requests[0].draft);
}

#[test]
fn snapshot_batches_six_thousand_unrelated_issues_and_one_hundred_project_tasks() {
    let f = Fixture::new();
    let history = 6000;
    let tasks = 100;
    for number in 1..=history + tasks {
        f.add_issue(Spec {
            project: (number > history).then_some(PROJECT),
            state: "CLOSED",
            reason: json!("COMPLETED"),
            ..spec(number)
        });
    }
    // Any repository-wide REST enumeration would fail instead of loading unrelated history.
    f.state().queue_pages = Value::Null;
    let snapshot = github_orchestrator::workstreams::snapshot(&dashboard_config(), &f.github(), &NoBranches).unwrap();
    assert_eq!(snapshot.tasks.len(), tasks as usize);
    let calls = f.calls();
    let graphql: Vec<_> = calls.iter().filter(|call| call.get(4).is_some_and(|arg| arg == "graphql")).collect();
    let membership: Vec<_> =
        graphql.iter().filter(|call| call.iter().any(|arg| arg.contains("node(id: $project)"))).collect();
    assert_eq!(membership.len(), 1); // One Project page, independent of unrelated repository history.
    assert_eq!(graphql.len(), 7); // 1 enumeration + 2 hydration + 2 labels + 2 branch PR batches.
    let query = membership[0].iter().find(|arg| arg.starts_with("query=")).unwrap();
    assert!(query.contains("archivedStates: [ARCHIVED, NOT_ARCHIVED]"));
    for excluded in ["body", "title", "assignees(", "projectItems(", "pullRequests(", "closedByPullRequestsReferences("]
    {
        assert!(!query.contains(excluded), "{query}");
    }
    assert!(!calls.iter().flatten().any(|arg| arg.contains("issues?state=") || arg.contains("projectItems(")));
    let dependencies =
        calls.iter().filter(|call| call.iter().any(|arg| arg.contains("dependencies/blocked_by?"))).count();
    assert_eq!(dependencies, tasks as usize);
    assert_eq!(calls.len(), 109); // GraphQL + dependencies + label list + Project lookup.
}

#[test]
fn batched_snapshot_continues_each_overflow_connection_from_its_first_page() {
    let f = Fixture::new();
    f.add_issue(spec(1));
    f.state().queue_pages = json!([[rest_issue(1, REPO, OWNER)]]);
    f.state().label_pages = json!([[{"name": "gho:workstream:last-page"}]]);
    let assignees =
        (0..=100).map(|index| json!({"id": format!("U_{index}"), "login": format!("user-{index}")})).collect();
    let closing = (1000..=1100).map(|number| pr_node(number, "MERGED", REPO)).collect();
    let labels = (0..=100).map(|index| json!({
        "id": format!("L_{index}"), "name": if index == 100 { "gho:workstream:last-page".into() } else { format!("label-{index}") }
    })).collect();
    {
        let mut state = f.state();
        for (field, nodes) in
            [("assignees", assignees), ("closedByPullRequestsReferences", closing), ("labels", labels)]
        {
            state.connections.insert((REPO.into(), 1, field), connection_pages(nodes, 100));
        }
        let prs = (2000..=2100)
            .map(|number| {
                let mut pr = pr_node(number, "MERGED", REPO);
                pr["headRefName"] = json!("worker/gh-1");
                pr
            })
            .collect();
        state.branch_prs = Some(HashMap::from([("worker/gh-1".into(), connection_pages(prs, 100))]));
    }
    let snapshot = github_orchestrator::workstreams::snapshot(&dashboard_config(), &f.github(), &NoBranches).unwrap();
    assert_eq!(snapshot.tasks.len(), 1);
    assert_eq!(snapshot.tasks[0].workstreams, ["last-page"]);
    assert_eq!(snapshot.tasks[0].pull_requests.len(), 202);
    let calls = f.calls();
    assert_eq!(calls.iter().filter(|call| call.contains(&"cursor=cursor-1".into())).count(), 4);
    // The first pages came from batch aliases, so no cursor-less single-issue reads are repeated.
    assert!(
        calls
            .iter()
            .filter(|call| call.contains(&"number=1".into()))
            .all(|call| call.contains(&"cursor=cursor-1".into()))
    );
}

#[test]
fn batched_snapshot_rejects_partial_connections_and_wrong_alias_identities() {
    for field in ["assignees", "closedByPullRequestsReferences", "labels", "branch"] {
        for damage in ["null", "truncated", "missing_count"] {
            let f = Fixture::new();
            f.add_issue(spec(1));
            f.state().queue_pages = json!([[rest_issue(1, REPO, OWNER)]]);
            let mut first = connection_pages(vec![], 100).remove(0);
            match damage {
                "null" => first = Value::Null,
                "truncated" => first["totalCount"] = json!(1),
                _ => {
                    first.as_object_mut().unwrap().remove("totalCount");
                }
            }
            if field == "branch" {
                f.state().branch_prs = Some(HashMap::from([("worker/gh-1".into(), vec![first])]));
            } else {
                f.state().connections.insert((REPO.into(), 1, field), vec![first]);
            }
            assert!(
                github_orchestrator::workstreams::snapshot(&dashboard_config(), &f.github(), &NoBranches).is_err(),
                "{field}: {damage}"
            );
        }
    }
    for damage in ["missing_alias", "wrong_identity", "graphql_errors"] {
        let f = Fixture::new();
        f.add_issue(spec(1));
        f.state().queue_pages = json!([[rest_issue(1, REPO, OWNER)]]);
        match damage {
            "missing_alias" => {
                f.state().issues.remove(&(REPO.into(), 1));
            }
            "wrong_identity" => f.state().issues.get_mut(&(REPO.into(), 1)).unwrap()["number"] = json!(2),
            _ => f.state().graphql_errors = vec![json!({"message":"partial response"})],
        }
        assert!(f.github().project_issues().is_err(), "{damage}");
    }
}

#[test]
fn snapshot_never_turns_partial_api_failure_into_empty_tasks() {
    for operation in ["labels?", "node(id: $project)", "pullRequests(", "dependencies/blocked_by?"] {
        let f = Fixture::new();
        f.add_issue(spec(1));
        f.state().queue_pages = json!([[rest_issue(1, REPO, OWNER)]]);
        f.state().before =
            Box::new(move |args| args.iter().any(|arg| arg.contains(operation)).then(|| http_error(args, "403")));
        fails(github_orchestrator::workstreams::snapshot(&dashboard_config(), &f.github(), &NoBranches), "HTTP 403");
    }
}
