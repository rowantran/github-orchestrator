//! GitHub.com adapter using gh's credentials and native issue relationships.
//!
//! Responses are decoded into strict types: missing, null, blank or unexpected data is an error,
//! so an inaccessible Project or a truncated page never looks like an empty queue.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashSet};
use std::fmt::Display;
use std::num::NonZeroU64;
use std::sync::LazyLock;

use regex::Regex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::domain::{Issue, IssueRef, IssueState, PullRequest, PullRequestState, StateReason, validate_repo};
use crate::process::{Cmd, Runner};
use crate::reviews::{PullRequestReviews, PullRequestStatus, Review, ReviewComment};
use crate::workstreams;
use crate::{Error, Result, ensure};

static PROJECT_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/(users|orgs)/([A-Za-z0-9-]+)/projects/([1-9][0-9]*)(?:/views/[1-9][0-9]*)?/?$").unwrap()
});
static PR_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)$").unwrap()
});
static LOGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9-]*$").unwrap());

const PR_FIELDS: &str = "id number url state merged isDraft baseRefName headRefName \
    mergeCommit { oid } repository { nameWithOwner } headRepository { nameWithOwner }";
const ISSUE_FIELDS: &str = "title body state stateReason issueDependenciesSummary { totalBlockedBy }";
const BATCH_SIZE: usize = 50;

fn metadata(detail: impl Display) -> Error {
    Error::msg(format!("Missing, inaccessible, or inconsistent GitHub metadata: {detail}"))
}

macro_rules! check {
    ($condition:expr, $($detail:tt)*) => {
        if !$condition {
            return Err(metadata(format!($($detail)*)));
        }
    };
}

fn parse<T: DeserializeOwned>(value: Value, detail: impl Display) -> Result<T> {
    serde_json::from_value(value).map_err(|error| metadata(format!("{detail}: {error}")))
}

/// A string that is present and not blank.
fn text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.trim().is_empty() {
        return Err(serde::de::Error::custom("expected a nonblank string"));
    }
    Ok(value)
}

/// A key that must be present, but may be null. (Plain `Option` fields may also be missing.)
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    Option::deserialize(deserializer)
}

// GraphQL shapes.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    total_count: u64,
    nodes: Vec<T>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    #[serde(deserialize_with = "present")]
    end_cursor: Option<String>,
}

trait Node {
    fn id(&self) -> &str;
}

#[derive(Deserialize)]
struct Assignee {
    #[serde(deserialize_with = "text")]
    id: String,
    #[serde(deserialize_with = "text")]
    login: String,
}

#[derive(Deserialize)]
struct LabelNode {
    #[serde(deserialize_with = "text")]
    id: String,
    #[serde(deserialize_with = "text")]
    name: String,
}

impl Node for LabelNode {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Deserialize)]
struct RestLabel {
    #[serde(deserialize_with = "text")]
    name: String,
}

#[derive(Deserialize)]
struct ProjectItem {
    #[serde(deserialize_with = "text")]
    id: String,
    project: Identified,
}

#[derive(Deserialize)]
struct ProjectCandidate {
    #[serde(deserialize_with = "text")]
    id: String,
    #[serde(rename = "isArchived")]
    _is_archived: bool,
    #[serde(rename = "type")]
    kind: String,
    #[serde(deserialize_with = "present")]
    content: Option<Value>,
}

impl Node for ProjectCandidate {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Deserialize)]
struct Identified {
    #[serde(deserialize_with = "text")]
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    #[serde(deserialize_with = "text")]
    name_with_owner: String,
}

#[derive(Deserialize)]
struct Commit {
    #[serde(deserialize_with = "text")]
    oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestNode {
    #[serde(deserialize_with = "text")]
    id: String,
    number: NonZeroU64,
    #[serde(deserialize_with = "text")]
    url: String,
    state: PullRequestState,
    merged: bool,
    is_draft: bool,
    #[serde(deserialize_with = "text")]
    base_ref_name: String,
    #[serde(deserialize_with = "text")]
    head_ref_name: String,
    #[serde(deserialize_with = "present")]
    merge_commit: Option<Commit>,
    repository: Repository,
    /// Null when the head repository (for example a fork) was deleted.
    #[serde(deserialize_with = "present")]
    head_repository: Option<Repository>,
}

impl Node for Assignee {
    fn id(&self) -> &str {
        &self.id
    }
}

impl Node for ProjectItem {
    fn id(&self) -> &str {
        &self.id
    }
}

impl Node for PullRequestNode {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Deserialize)]
struct IssueIdentity {
    #[serde(deserialize_with = "text", rename = "id")]
    _id: String,
    number: NonZeroU64,
    #[serde(deserialize_with = "text")]
    url: String,
    repository: Repository,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueFields {
    #[serde(deserialize_with = "text")]
    title: String,
    body: String,
    state: IssueState,
    #[serde(deserialize_with = "present")]
    state_reason: Option<StateReason>,
    issue_dependencies_summary: DependencySummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DependencySummary {
    total_blocked_by: u64,
}

// REST shapes.

#[derive(Deserialize)]
struct RestIssue {
    number: NonZeroU64,
    #[serde(deserialize_with = "text")]
    html_url: String,
}

#[derive(Deserialize)]
struct QueueCandidate {
    number: NonZeroU64,
    #[serde(deserialize_with = "text")]
    html_url: String,
    #[serde(deserialize_with = "text")]
    state: String,
    assignees: Vec<Login>,
}

#[derive(Deserialize)]
struct Login {
    #[serde(deserialize_with = "text")]
    login: String,
}

/// A GitHub Projects v2 board.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Project {
    #[serde(deserialize_with = "text")]
    pub id: String,
    #[serde(deserialize_with = "text")]
    pub url: String,
    #[serde(deserialize_with = "text")]
    pub title: String,
}

/// The parts of a `https://github.com/{users|orgs}/OWNER/projects/N` URL.
#[derive(Debug, PartialEq, Eq)]
struct ProjectPath {
    kind: String,
    owner: String,
    number: String,
}

fn project_path(url: &str) -> Result<ProjectPath> {
    let path = url
        .strip_prefix("https://github.com")
        .filter(|rest| rest.starts_with('/'))
        .and_then(|rest| rest.split(['?', '#']).next())
        .and_then(|path| PROJECT_PATH.captures(path));
    match path {
        Some(captures) => {
            Ok(ProjectPath { kind: captures[1].into(), owner: captures[2].into(), number: captures[3].into() })
        }
        None => Err(Error::msg("Use a https://github.com/users/OWNER/projects/N or /orgs/OWNER/projects/N URL.")),
    }
}

/// Parse a REST issue object, refusing pull requests (which the issues API also returns).
fn rest<T: DeserializeOwned>(value: Value, detail: impl Display) -> Result<T> {
    check!(value.is_object(), "{detail}: expected an object");
    check!(value.get("pull_request").is_none(), "expected an issue, not a pull request");
    parse(value, detail)
}

fn issue_ref(html_url: &str, number: NonZeroU64) -> Result<IssueRef> {
    let reference = IssueRef::parse(html_url, None)?;
    check!(reference.number() == number.get(), "issue number");
    Ok(reference)
}

/// Collect every node of a GraphQL connection, rejecting partial or changing results.
fn paginate<T: Node>(mut fetch: impl FnMut(Option<&str>) -> Result<Page<T>>) -> Result<Vec<T>> {
    let mut result = Vec::new();
    let mut cursor: Option<String> = None;
    let mut cursors = HashSet::new();
    let mut ids = HashSet::new();
    let mut expected = None;
    loop {
        let page = fetch(cursor.as_deref())?;
        let expected = *expected.get_or_insert(page.total_count);
        check!(page.total_count == expected, "connection changed during pagination; retry");
        let advanced = !page.nodes.is_empty();
        for node in page.nodes {
            check!(ids.insert(node.id().to_owned()), "duplicate connection node");
            result.push(node);
        }
        let count = result.len() as u64;
        check!(count <= expected, "connection count");
        if !page.page_info.has_next_page {
            check!(count == expected, "truncated connection");
            return Ok(result);
        }
        let next = page.page_info.end_cursor.filter(|c| !c.trim().is_empty());
        let Some(next) = next else { return Err(metadata("endCursor")) };
        check!(advanced && count < expected && cursors.insert(next.clone()), "pagination did not advance");
        cursor = Some(next);
    }
}

enum Var<'a> {
    Str(&'a str),
    Int(u64),
}

pub struct GitHub<'a> {
    repo: String,
    project_url: String,
    /// Looked up from `project_url` on first use.
    project: OnceCell<Project>,
    owner: String,
    runner: &'a dyn Runner,
}

impl<'a> GitHub<'a> {
    pub fn new(repo: &str, project_url: &str, owner: &str, runner: &'a dyn Runner) -> Result<Self> {
        validate_repo(repo)?;
        check!(LOGIN.is_match(owner), "owner login");
        project_path(project_url)?;
        Ok(GitHub {
            repo: repo.into(),
            project_url: project_url.into(),
            project: OnceCell::new(),
            owner: owner.into(),
            runner,
        })
    }

    fn run<S: AsRef<str>>(&self, args: &[S]) -> Result<String> {
        let argv = std::iter::once("gh").chain(args.iter().map(AsRef::as_ref));
        // Project commands have no --hostname option; do not let GH_HOST select another service.
        self.runner.run(&Cmd::new(argv).env("GH_HOST", "github.com"))
    }

    fn json<S: AsRef<str>>(&self, args: &[S]) -> Result<Value> {
        serde_json::from_str(&self.run(args)?)
            .map_err(|_| Error::msg("GitHub returned invalid JSON; no success assumed."))
    }

    fn api(&self, endpoint: &str, extra: &[&str]) -> Result<Value> {
        let mut args = vec!["api", "--hostname", "github.com", endpoint];
        args.extend_from_slice(extra);
        self.json(&args)
    }

    fn graphql(&self, query: &str, variables: &[(&str, Var)]) -> Result<Value> {
        let mut args = vec!["api".to_string(), "--hostname".into(), "github.com".into(), "graphql".into()];
        args.extend(["-f".into(), format!("query={query}")]);
        for (key, value) in variables {
            match value {
                Var::Str(value) => args.extend(["-f".into(), format!("{key}={value}")]),
                Var::Int(value) => args.extend(["-F".into(), format!("{key}={value}")]),
            }
        }
        let mut response = self.json(&args)?;
        check!(response.is_object(), "GraphQL response");
        match response.get("errors") {
            None | Some(Value::Null) => {}
            Some(Value::Array(errors)) if errors.is_empty() => {}
            Some(errors) => {
                let errors = errors.to_string();
                let end = errors.char_indices().nth(2000).map_or(errors.len(), |(i, _)| i);
                return Err(Error::msg(format!("GitHub GraphQL error: {}", &errors[..end])));
            }
        }
        let data = response.get_mut("data").map(Value::take).unwrap_or_default();
        check!(data.is_object(), "GraphQL data");
        Ok(data)
    }

    /// Every item of a paginated REST list.
    fn rest_pages(&self, endpoint: &str) -> Result<Vec<Value>> {
        let pages: Vec<Vec<Value>> = parse(self.api(endpoint, &["--paginate", "--slurp"])?, "REST pagination")?;
        check!(!pages.is_empty(), "REST pagination");
        let items: Vec<Value> = pages.into_iter().flatten().collect();
        check!(items.iter().all(Value::is_object), "REST item");
        Ok(items)
    }

    /// The configured Project, looked up once. Fails when the Project is inaccessible.
    fn project(&self) -> Result<&Project> {
        if let Some(project) = self.project.get() {
            return Ok(project);
        }
        let project = self.resolve_project(&self.project_url)?;
        Ok(self.project.get_or_init(|| project))
    }

    /// Look up a Project by its URL.
    pub fn resolve_project(&self, url: &str) -> Result<Project> {
        let wanted = project_path(url)?;
        let value = self.json(&["project", "view", &wanted.number, "--owner", &wanted.owner, "--format", "json"])?;
        let project: Project = parse(value, "project")?;
        let actual = project_path(&project.url)?;
        check!(
            actual.kind == wanted.kind
                && actual.owner.eq_ignore_ascii_case(&wanted.owner)
                && actual.number == wanted.number,
            "project URL"
        );
        Ok(project)
    }

    /// The issue object with `fields` selected, after checking it is the requested issue.
    fn issue_data(&self, reference: &IssueRef, fields: &str, cursor: Option<&str>) -> Result<Value> {
        let (owner, name) = reference.repo().split_once('/').expect("validated OWNER/REPO");
        // Only connection queries declare the cursor; GraphQL rejects unused variables.
        let declaration = if fields.contains("$cursor") { ", $cursor: String" } else { "" };
        let query = format!(
            "query($owner: String!, $name: String!, $number: Int!{declaration}) {{ \
             repository(owner: $owner, name: $name) {{ issue(number: $number) {{ \
             id number url repository {{ nameWithOwner }} {fields} }} }} }}"
        );
        let mut variables =
            vec![("owner", Var::Str(owner)), ("name", Var::Str(name)), ("number", Var::Int(reference.number()))];
        if let Some(cursor) = cursor {
            variables.push(("cursor", Var::Str(cursor)));
        }
        let mut data = self.graphql(&query, &variables)?;
        let issue = data.pointer_mut("/repository/issue").map(Value::take).unwrap_or_default();
        check_issue_identity(reference, &issue)?;
        Ok(issue)
    }

    /// At most fifty repository issues per request. Numeric aliases are derived from validated
    /// references, never user query text. Every alias and issue identity must be present and correct.
    fn issue_batch(&self, references: &[IssueRef], fields: &str) -> Result<Vec<Value>> {
        check!(references.len() <= BATCH_SIZE, "issue batch size");
        let (owner, name) = self.repo.split_once('/').expect("validated OWNER/REPO");
        let mut selections = String::new();
        let mut seen = HashSet::new();
        for reference in references {
            check!(reference.repo().eq_ignore_ascii_case(&self.repo), "issue batch repository");
            check!(seen.insert(reference), "duplicate issue batch reference");
            selections.push_str(&format!(
                "issue_{number}: issue(number: {number}) {{ id number url repository {{ nameWithOwner }} {fields} }} ",
                number = reference.number()
            ));
        }
        let query = format!(
            "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ {selections} }} }}"
        );
        let mut data = self.graphql(&query, &[("owner", Var::Str(owner)), ("name", Var::Str(name))])?;
        references
            .iter()
            .map(|reference| {
                let path = format!("/repository/issue_{}", reference.number());
                let issue = data.pointer_mut(&path).map(Value::take).unwrap_or_default();
                check_issue_identity(reference, &issue)?;
                Ok(issue)
            })
            .collect()
    }

    fn issue_connection<T: Node + DeserializeOwned>(
        &self,
        reference: &IssueRef,
        field: &str,
        selection: &str,
        extra: &str,
    ) -> Result<Vec<T>> {
        self.issue_connection_from(reference, field, selection, extra, None)
    }

    /// Continue a connection whose first page may have arrived in a batch. The normal pagination
    /// validator checks that first page too, including truncated counts and non-advancing cursors.
    fn issue_connection_from<T: Node + DeserializeOwned>(
        &self,
        reference: &IssueRef,
        field: &str,
        selection: &str,
        extra: &str,
        mut first: Option<Value>,
    ) -> Result<Vec<T>> {
        let fields = format!(
            "{field}(first: 100, after: $cursor{extra}) {{ totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ {selection} }} }}"
        );
        paginate(|cursor| {
            let connection = if let Some(first) = first.take() {
                first
            } else {
                let mut issue = self.issue_data(reference, &fields, cursor)?;
                issue.get_mut(field).map(Value::take).unwrap_or_default()
            };
            parse(connection, field)
        })
    }

    /// Open issues in the repository that are assigned to the owner and in the Project, by number.
    pub fn queue(&self) -> Result<Vec<Issue>> {
        self.project()?; // An inaccessible project must not look like an empty queue.
        let repo = self.repo.to_lowercase();
        let endpoint = format!("repos/{}/issues?state=open&assignee={}&per_page=100", self.repo, self.owner);
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for candidate in self.rest_pages(&endpoint)? {
            if candidate.get("pull_request").is_some() {
                continue;
            }
            let candidate: QueueCandidate = parse(candidate, "queue issue")?;
            let reference = issue_ref(&candidate.html_url, candidate.number)?;
            if reference.repo() != repo {
                continue;
            }
            check!(seen.insert(reference.clone()), "duplicate issue in paginated queue");
            let state = candidate.state.to_uppercase();
            check!(state == "OPEN" || state == "CLOSED", "issue state");
            let assigned = candidate.assignees.iter().any(|a| a.login.eq_ignore_ascii_case(&self.owner));
            if !assigned || state != "OPEN" {
                continue;
            }
            // The REST search can lag; confirm state, assignment and Project membership live.
            let issue = self.issue(&reference)?;
            if issue.state == IssueState::Open
                && issue.project_ids.contains(&self.project()?.id)
                && issue.assignees.iter().any(|a| a.eq_ignore_ascii_case(&self.owner))
            {
                result.push(issue);
            }
        }
        result.sort_by(|a, b| a.reference.cmp(&b.reference));
        Ok(result)
    }

    /// All repository issues in the configured Project, regardless of assignee or state. Enumerate
    /// both archived and active Project items, never repository issue or pull request history.
    /// Only matching issues are hydrated, in batches of fifty.
    pub fn project_issues(&self) -> Result<Vec<Issue>> {
        let project_id = self.project()?.id.clone();
        let query = "query($project: ID!, $cursor: String) { node(id: $project) { __typename \
            ... on ProjectV2 { id items(first: 100, after: $cursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) { \
            totalCount pageInfo { hasNextPage endCursor } nodes { id isArchived type content { __typename \
            ... on Issue { id number url repository { nameWithOwner } } } } } } } }";
        let candidates: Vec<ProjectCandidate> = paginate(|cursor| {
            let mut variables = vec![("project", Var::Str(&project_id))];
            if let Some(cursor) = cursor {
                variables.push(("cursor", Var::Str(cursor)));
            }
            let mut data = self.graphql(query, &variables)?;
            let node = data.get_mut("node").ok_or_else(|| metadata("project node"))?;
            check!(node.get("__typename").and_then(Value::as_str) == Some("ProjectV2"), "project node type");
            check!(node.get("id").and_then(Value::as_str) == Some(project_id.as_str()), "project node identity");
            parse(node.get_mut("items").map(Value::take).unwrap_or_default(), "project items")
        })?;
        let mut seen = HashSet::new();
        let mut content_ids = HashSet::new();
        let mut members = Vec::new();
        for candidate in candidates {
            let expected_type = match candidate.kind.as_str() {
                "ISSUE" => "Issue",
                "PULL_REQUEST" => "PullRequest",
                "DRAFT_ISSUE" => "DraftIssue",
                "REDACTED" => return Err(metadata("redacted project item")),
                _ => return Err(metadata("unknown project item type")),
            };
            let content = candidate.content.ok_or_else(|| metadata("project item content"))?;
            check!(
                content.get("__typename").and_then(Value::as_str) == Some(expected_type),
                "project item content type"
            );
            if expected_type != "Issue" {
                continue;
            }
            let identity: IssueIdentity = parse(content.clone(), "project issue")?;
            let reference = issue_ref(&identity.url, identity.number)?;
            check_issue_identity(&reference, &content)?;
            check!(seen.insert(reference.clone()), "duplicate issue in paginated project items");
            check!(content_ids.insert(identity._id.clone()), "duplicate project issue identity");
            if reference.repo().eq_ignore_ascii_case(&self.repo) {
                members.push((reference, identity._id));
            }
        }
        // Hydrate only Project members. Assignees and linked PRs share the issue-fields request;
        // rare connections over one page continue through the existing strict cursor reader.
        let fields = format!(
            "{ISSUE_FIELDS} \
             assignees(first: 100) {{ totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ id login }} }} \
             closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {{ \
             totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ {PR_FIELDS} }} }}"
        );
        let mut result = Vec::new();
        for chunk in members.chunks(BATCH_SIZE) {
            let references: Vec<_> = chunk.iter().map(|(reference, _)| reference.clone()).collect();
            for ((reference, id), value) in chunk.iter().zip(self.issue_batch(&references, &fields)?) {
                check!(value.get("id").and_then(Value::as_str) == Some(id.as_str()), "project issue identity changed");
                result.push(self.read_issue(reference, Some(vec![project_id.clone()]), Some(value))?);
            }
        }
        result.sort_by(|a, b| a.reference.cmp(&b.reference));
        Ok(result)
    }

    /// All labels currently attached to an issue. Paginated and identity-checked like other issue
    /// connections, so a pull request number or inaccessible issue is never silently accepted.
    pub fn issue_labels(&self, reference: &IssueRef) -> Result<Vec<String>> {
        let labels: Vec<LabelNode> = self.issue_connection(reference, "labels", "id name", "")?;
        label_names(labels.into_iter().map(|label| label.name))
    }

    /// Snapshot labels, in input order. Each first page shares a request with up to 49 other issues.
    pub(crate) fn issue_labels_batch(&self, references: &[IssueRef]) -> Result<Vec<Vec<String>>> {
        let fields = "labels(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { id name } }";
        let mut result = Vec::new();
        for chunk in references.chunks(BATCH_SIZE) {
            for (reference, mut value) in chunk.iter().zip(self.issue_batch(chunk, fields)?) {
                let first = value.get_mut("labels").map(Value::take).unwrap_or_default();
                let labels: Vec<LabelNode> =
                    self.issue_connection_from(reference, "labels", "id name", "", Some(first))?;
                result.push(label_names(labels.into_iter().map(|label| label.name))?);
            }
        }
        Ok(result)
    }

    /// Defined workstreams, including labels not currently attached to any issue.
    pub fn workstreams(&self) -> Result<Vec<String>> {
        let endpoint = format!("repos/{}/labels?per_page=100", self.repo);
        let labels = self.rest_pages(&endpoint)?.into_iter().map(|value| parse::<RestLabel>(value, "label"));
        let names = label_names(labels.collect::<Result<Vec<_>>>()?.into_iter().map(|label| label.name))?;
        workstreams::names(&names)
    }

    /// Define a workstream without changing an existing label's description or color.
    pub fn create_workstream(&self, name: &str) -> Result<()> {
        let label = workstreams::label(name)?;
        if self.workstreams()?.iter().any(|existing| existing.eq_ignore_ascii_case(name)) {
            return Ok(());
        }
        let endpoint = format!("repos/{}/labels", self.repo);
        let created = self.api(&endpoint, &["--method", "POST", "-f", &format!("name={label}"), "-f", "color=5319e7"]);
        let value = match created {
            Ok(value) => value,
            Err(error) => {
                // Another client may have created the label after our read. Only recover GitHub's
                // conflict response, not authentication, transport or malformed-response failures.
                if matches!(&error, Error::Command { stderr, .. } if stderr.contains("HTTP 422"))
                    && self.workstreams()?.iter().any(|existing| existing.eq_ignore_ascii_case(name))
                {
                    return Ok(());
                }
                return Err(Error::msg(format!(
                    "Could not create workstream {name:?}: {error}. Check the repository labels before retrying."
                )));
            }
        };
        let verify = || -> Result<()> {
            let created: RestLabel = parse(value, "created workstream label")?;
            check!(created.name.eq_ignore_ascii_case(&label), "created workstream label name");
            Ok(())
        };
        verify().map_err(|error| {
            Error::msg(format!(
                "Workstream {name:?} may have been created, but the response could not be verified: {error}. \
             Check the repository labels before retrying."
            ))
        })
    }

    pub fn add_to_workstream(&self, name: &str, issues: &[IssueRef]) -> Result<()> {
        self.change_workstream(name, issues, true)
    }

    pub fn remove_from_workstream(&self, name: &str, issues: &[IssueRef]) -> Result<()> {
        self.change_workstream(name, issues, false)
    }

    fn change_workstream(&self, name: &str, issues: &[IssueRef], add: bool) -> Result<()> {
        let label = workstreams::label(name)?;
        // Validate the entire request before writing anything.
        for reference in issues {
            ensure!(
                reference.repo().eq_ignore_ascii_case(&self.repo),
                "Workstream {name:?} belongs to {}; cannot change {}.",
                self.repo,
                reference.url()
            );
        }
        ensure!(
            self.workstreams()?.iter().any(|existing| existing.eq_ignore_ascii_case(name)),
            "Unknown workstream {name:?}. Create it before changing membership."
        );
        let mut completed = Vec::new();
        let mut seen = HashSet::new();
        for reference in issues {
            if !seen.insert(reference) {
                continue;
            }
            let update = || -> Result<()> {
                let labels = self.issue_labels(reference)?;
                if labels.iter().any(|existing| existing.eq_ignore_ascii_case(&label)) == add {
                    return Ok(());
                }
                let endpoint = format!("repos/{}/issues/{}/labels", self.repo, reference.number());
                let response = if add {
                    // POST appends; PUT would replace unrelated labels and other memberships.
                    self.api(&endpoint, &["--method", "POST", "-f", &format!("labels[]={label}")])?
                } else {
                    // Encode the complete label: slashes in names are data, not URL path separators.
                    let encoded: String = label.bytes().map(|byte| format!("%{byte:02X}")).collect();
                    self.api(&format!("{endpoint}/{encoded}"), &["--method", "DELETE"])?
                };
                let labels: Vec<RestLabel> = parse(response, "updated issue labels")?;
                let labels = label_names(labels.into_iter().map(|label| label.name))?;
                check!(
                    labels.iter().any(|existing| existing.eq_ignore_ascii_case(&label)) == add,
                    "workstream membership after update"
                );
                Ok(())
            };
            if let Err(error) = update() {
                let action = if add { "add to" } else { "remove from" };
                let previous = if completed.is_empty() { "none".into() } else { completed.join(", ") };
                return Err(Error::msg(format!(
                    "Could not {action} workstream {name:?} for {}: {error}. \
                     Earlier successful issues: {previous}. The failing issue may have changed; \
                     remaining issues were not attempted. Check membership before retrying.",
                    reference.url()
                )));
            }
            completed.push(reference.url());
        }
        Ok(())
    }

    fn issue_project_ids(&self, reference: &IssueRef) -> Result<Vec<String>> {
        let items: Vec<ProjectItem> =
            self.issue_connection(reference, "projectItems", "id project { id }", ", includeArchived: true")?;
        project_ids(items, &self.project()?.id)
    }

    /// Any issue on github.com. Deliberately not restricted to this queue: blockers can be anywhere.
    pub fn issue(&self, reference: &IssueRef) -> Result<Issue> {
        self.read_issue(reference, None, None)
    }

    fn read_issue(
        &self,
        reference: &IssueRef,
        project_ids: Option<Vec<String>>,
        initial: Option<Value>,
    ) -> Result<Issue> {
        let batched = initial.is_some();
        let mut value = match initial {
            Some(value) => value,
            None => self.issue_data(reference, ISSUE_FIELDS, None)?,
        };
        let first_assignees = batched.then(|| value.get_mut("assignees").map(Value::take).unwrap_or_default());
        let first_closing =
            batched.then(|| value.get_mut("closedByPullRequestsReferences").map(Value::take).unwrap_or_default());
        let data: IssueFields = parse(value, "issue")?;
        check!(data.state != IssueState::Closed || data.state_reason.is_some(), "closed issue stateReason");
        let assignees: Vec<Assignee> =
            self.issue_connection_from(reference, "assignees", "id login", "", first_assignees)?;
        let project_ids = match project_ids {
            Some(ids) => ids,
            None => self.issue_project_ids(reference)?,
        };
        let closing: Vec<PullRequestNode> = self.issue_connection_from(
            reference,
            "closedByPullRequestsReferences",
            PR_FIELDS,
            ", includeClosedPrs: true",
            first_closing,
        )?;
        let endpoint =
            format!("repos/{}/issues/{}/dependencies/blocked_by?per_page=100", reference.repo(), reference.number());
        let blockers = self
            .rest_pages(&endpoint)?
            .into_iter()
            .map(|value| rest::<RestIssue>(value, "blocking issue").and_then(|i| issue_ref(&i.html_url, i.number)))
            .collect::<Result<Vec<_>>>()?;
        let unique: HashSet<&IssueRef> = blockers.iter().collect();
        check!(
            unique.len() == blockers.len() && blockers.len() as u64 == data.issue_dependencies_summary.total_blocked_by,
            "incomplete or inaccessible blocking dependencies"
        );
        Ok(Issue {
            reference: reference.clone(),
            title: data.title,
            body: data.body,
            state: data.state,
            state_reason: data.state_reason,
            assignees: assignees.into_iter().map(|a| a.login).collect(),
            project_ids,
            blockers,
            pull_requests: closing.into_iter().map(pull_request).collect::<Result<_>>()?,
        })
    }

    /// The open pull request (draft or not) from `branch` in this repository, if any.
    ///
    /// Found by head branch, not by closing keywords: GitHub ignores "Closes #N" on pull requests
    /// that target a branch other than the default branch, so stacked pull requests are never linked.
    pub fn open_pull_request(&self, branch: &str) -> Result<Option<PullRequest>> {
        let mut found = self.branch_pull_requests(branch, true)?;
        if found.len() > 1 {
            let urls: Vec<&str> = found.iter().map(|pr| pr.url.as_str()).collect();
            return Err(Error::msg(format!(
                "More than one open pull request from {branch}: {}. Close the extras.",
                urls.join(", ")
            )));
        }
        Ok(found.pop())
    }

    /// All pull requests from a local-repository branch, including completed stacked pull requests
    /// that GitHub never linked through closing keywords.
    pub fn pull_requests(&self, branch: &str) -> Result<Vec<PullRequest>> {
        self.branch_pull_requests(branch, false)
    }

    /// Snapshot branch matches, in input order. This includes merged stacked pull requests. Branch
    /// names stay GraphQL variables, and each connection retains independent pagination checks.
    pub(crate) fn pull_requests_batch(&self, branches: &[String]) -> Result<Vec<Vec<PullRequest>>> {
        let (owner, name) = self.repo.split_once('/').expect("validated OWNER/REPO");
        let mut result = Vec::new();
        for chunk in branches.chunks(BATCH_SIZE) {
            let keys: Vec<_> = (0..chunk.len()).map(|index| format!("branch_{index}")).collect();
            let declarations: String = keys.iter().map(|key| format!(", ${key}: String!")).collect();
            let fields: String = keys
                .iter()
                .enumerate()
                .map(|(index, key)| {
                    format!(
                        "pr_{index}: pullRequests(headRefName: ${key}, states: [OPEN, CLOSED, MERGED], first: 100) {{ \
                 totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ {PR_FIELDS} }} }} "
                    )
                })
                .collect();
            let query = format!(
                "query($owner: String!, $name: String!{declarations}) {{ \
                 repository(owner: $owner, name: $name) {{ {fields} }} }}"
            );
            let mut variables = vec![("owner", Var::Str(owner)), ("name", Var::Str(name))];
            variables.extend(keys.iter().zip(chunk).map(|(key, branch)| (key.as_str(), Var::Str(branch))));
            let mut data = self.graphql(&query, &variables)?;
            for (index, branch) in chunk.iter().enumerate() {
                let first = data.pointer_mut(&format!("/repository/pr_{index}")).map(Value::take).unwrap_or_default();
                result.push(self.branch_pull_requests_from(branch, false, Some(first))?);
            }
        }
        Ok(result)
    }

    fn branch_pull_requests(&self, branch: &str, open_only: bool) -> Result<Vec<PullRequest>> {
        self.branch_pull_requests_from(branch, open_only, None)
    }

    fn branch_pull_requests_from(
        &self,
        branch: &str,
        open_only: bool,
        mut first: Option<Value>,
    ) -> Result<Vec<PullRequest>> {
        let (owner, name) = self.repo.split_once('/').expect("validated OWNER/REPO");
        let states = if open_only { "OPEN" } else { "OPEN, CLOSED, MERGED" };
        let query = format!(
            "query($owner: String!, $name: String!, $branch: String!, $cursor: String) {{ \
             repository(owner: $owner, name: $name) {{ \
             pullRequests(headRefName: $branch, states: [{states}], first: 100, after: $cursor) {{ \
             totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ {PR_FIELDS} }} }} }} }}"
        );
        let nodes: Vec<PullRequestNode> = paginate(|cursor| {
            if let Some(first) = first.take() {
                return parse(first, "pull requests (check repository access)");
            }
            let mut variables =
                vec![("owner", Var::Str(owner)), ("name", Var::Str(name)), ("branch", Var::Str(branch))];
            if let Some(cursor) = cursor {
                variables.push(("cursor", Var::Str(cursor)));
            }
            let mut data = self.graphql(&query, &variables)?;
            let connection = data.pointer_mut("/repository/pullRequests").map(Value::take).unwrap_or_default();
            parse(connection, "pull requests (check repository access)")
        })?;
        let repo = self.repo.to_lowercase();
        let mut found = Vec::new();
        for node in nodes {
            // A fork's branch with the same name is someone else's work.
            let head = node.head_repository.as_ref().map(|r| r.name_with_owner.to_lowercase());
            let pr = pull_request(node)?;
            check!(
                (!open_only || pr.state == PullRequestState::Open) && pr.head == branch,
                "pull request for {branch}"
            );
            check!(pr.repo.to_lowercase() == repo, "pull request repository");
            if head.as_deref() == Some(repo.as_str()) {
                found.push(pr);
            }
        }
        found.sort_by_key(|pr| pr.number);
        Ok(found)
    }

    /// Create an issue assigned to the owner and blocked by `blockers`, then add it to the Project.
    pub fn create_issue(&self, title: &str, body: &str, blockers: &[IssueRef]) -> Result<Issue> {
        let project = project_path(&self.project()?.url)?;
        let blockers: BTreeSet<&IssueRef> = blockers.iter().collect();
        let repo = format!("github.com/{}", self.repo);
        let mut args: Vec<String> =
            ["issue", "create", "--repo", &repo, "--title", title, "--body", body, "--assignee", &self.owner]
                .map(String::from)
                .into();
        // gh (2.94+) resolves issue URLs to IDs and adds the native "blocked by" links itself.
        for blocker in &blockers {
            args.extend(["--blocked-by".into(), blocker.url()]);
        }
        let output = self.run(&args).map_err(|error| {
            if blockers.is_empty() {
                return error;
            }
            // gh creates the issue before linking blockers, and prints no URL if linking fails.
            Error::msg(format!(
                "{error}\ngh may have created the issue before this failure, without adding it to the Project. \
                 Search {} for an issue titled {title:?} before retrying; do not create it twice.",
                self.repo
            ))
        })?;
        let url = output.trim();
        let setup = || -> Result<Issue> {
            let reference = IssueRef::parse(url, None)?;
            check!(reference.repo() == self.repo.to_lowercase(), "created issue repository: {url}");
            let item = self.json(&[
                "project",
                "item-add",
                &project.number,
                "--owner",
                &project.owner,
                "--url",
                &reference.url(),
                "--format",
                "json",
            ])?;
            parse::<Identified>(item, "created project item")?;
            let issue = self.issue(&reference)?;
            check!(issue.project_ids.contains(&self.project()?.id), "created issue project membership");
            check!(issue.assignees.iter().any(|a| a.eq_ignore_ascii_case(&self.owner)), "created issue assignee");
            check!(blockers.iter().all(|blocker| issue.blockers.contains(blocker)), "created issue dependencies");
            Ok(issue)
        };
        setup().map_err(|error| {
            Error::msg(format!(
                "Created {url}, but setup is incomplete: {error}. Repair this issue; do not recreate it."
            ))
        })
    }
}

impl PullRequestReviews for GitHub<'_> {
    fn pull_request_status(&self, number: u64) -> Result<PullRequestStatus> {
        let value = self.api(&format!("repos/{}/pulls/{number}", self.repo), &[])?;
        let status: PullRequestStatus = parse(value, "pull request (check repository access)")?;
        check!(status.number == number, "pull request number");
        Ok(status)
    }

    fn reviews(&self, number: u64) -> Result<Vec<Review>> {
        let endpoint = format!("repos/{}/pulls/{number}/reviews?per_page=100", self.repo);
        self.rest_pages(&endpoint)?.into_iter().map(|value| parse(value, "pull request review")).collect()
    }

    fn review_comments(&self, number: u64) -> Result<Vec<ReviewComment>> {
        let endpoint = format!("repos/{}/pulls/{number}/comments?per_page=100", self.repo);
        self.rest_pages(&endpoint)?.into_iter().map(|value| parse(value, "pull request review comment")).collect()
    }
}

fn check_issue_identity(reference: &IssueRef, issue: &Value) -> Result<()> {
    check!(issue.is_object(), "{}", reference.url());
    let identity = IssueIdentity::deserialize(issue).map_err(|error| metadata(format!("issue: {error}")))?;
    let actual = IssueRef::parse(&identity.url, None)?;
    check!(actual == *reference && identity.number.get() == reference.number(), "issue identity");
    check!(identity.repository.name_with_owner.to_lowercase() == reference.repo(), "issue repository");
    Ok(())
}

fn project_ids(items: Vec<ProjectItem>, project_id: &str) -> Result<Vec<String>> {
    let ids: Vec<String> = items.into_iter().map(|item| item.project.id).collect();
    check!(ids.iter().filter(|id| *id == project_id).count() <= 1, "duplicate project membership");
    Ok(ids)
}

fn label_names(names: impl Iterator<Item = String>) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for name in names {
        check!(seen.insert(name.to_lowercase()), "duplicate label name");
        result.push(name);
    }
    result.sort();
    Ok(result)
}

fn pull_request(node: PullRequestNode) -> Result<PullRequest> {
    let Some(captures) = PR_URL.captures(&node.url) else {
        return Err(metadata("pull request URL must be on github.com"));
    };
    check!(
        captures[1].eq_ignore_ascii_case(&node.repository.name_with_owner) && captures[2] == node.number.to_string(),
        "pull request identity"
    );
    check!(node.merged == (node.state == PullRequestState::Merged), "pull request merged state");
    let merge_commit = node.merge_commit.map(|commit| commit.oid);
    check!(!node.merged || merge_commit.is_some(), "merged pull request commit");
    Ok(PullRequest {
        number: node.number.get(),
        url: node.url,
        repo: node.repository.name_with_owner,
        state: node.state,
        draft: node.is_draft,
        base: node.base_ref_name,
        head: node.head_ref_name,
        merge_commit,
    })
}
