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
    project: Value,
    before: Hook,
    graphql_errors: Vec<Value>,
    raw_output: Option<String>,
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
        let state = self.0.borrow();
        if args[..3] == ["api", "--hostname", "github.com"] {
            let endpoint = args[3].as_str();
            if endpoint == "graphql" {
                let params: HashMap<&str, &str> = args[4..].iter().filter_map(|a| a.split_once('=')).collect();
                let query = params["query"];
                let data = if query.contains("issue(number:") {
                    let repo = format!("{}/{}", params["owner"], params["name"]).to_lowercase();
                    let number: u64 = params["number"].parse().unwrap();
                    let mut issue = state.issues.get(&(repo.clone(), number)).cloned().unwrap_or(Value::Null);
                    if issue.is_object() {
                        for field in ["assignees", "projectItems", "closedByPullRequestsReferences"] {
                            if query.contains(&format!("{field}(")) {
                                let cursor = params.get("cursor").copied().unwrap_or("cursor-0");
                                let page: usize = cursor.split('-').nth(1).unwrap().parse().unwrap();
                                issue[field] = state.connections[&(repo.clone(), number, field)][page].clone();
                            }
                        }
                    }
                    json!({"repository": {"issue": issue}})
                } else if query.contains("pullRequests(headRefName: $branch, states: [OPEN]") {
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
            if parts[3].starts_with("issues?") {
                assert!(paginated && endpoint.contains("per_page=100"));
                return state.queue_pages.to_string();
            }
            let number: u64 = parts[4].parse().unwrap();
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
