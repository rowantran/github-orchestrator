//! Overlapping workstreams stored as repository labels, and a read-only dashboard snapshot.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use crate::config::Config;
use crate::domain::{Issue, IssueRef, PullRequest, PullRequestState};
use crate::github::GitHub;
use crate::work::{self, Branches, Entry, Issues, LinkedPullRequest};
use crate::{Error, Result, ensure};

const PREFIX: &str = "gho:workstream:";

/// The GitHub label for a workstream. Slash-separated names are independent labels, not a hierarchy.
/// Each segment starts with an ASCII letter or digit and uses only letters, digits, `.`, `_`, `-`.
/// The complete label must fit GitHub's 50-character limit. Whitespace, commas and option-like names
/// are rejected rather than trimmed or interpreted as several labels.
pub fn label(name: &str) -> Result<String> {
    ensure!(
        !name.is_empty()
            && PREFIX.len() + name.len() <= 50
            && name.split('/').all(|segment| {
                segment.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                    && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            }),
        "Invalid workstream name {name:?}. Use slash-separated names starting with a letter or digit, \
         with only letters, digits, '.', '_' or '-'; at most {} characters total.",
        50 - PREFIX.len()
    );
    Ok(format!("{PREFIX}{name}"))
}

/// Decode only the reserved labels. Invalid reserved labels are errors, not silently missing work.
pub(crate) fn names(labels: &[String]) -> Result<Vec<String>> {
    let mut names = BTreeSet::new();
    for value in labels {
        if value.get(..PREFIX.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(PREFIX)) {
            let name = &value[PREFIX.len()..];
            label(name)?;
            names.insert(name.to_owned());
        }
    }
    Ok(names.into_iter().collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub repo: String,
    pub project_url: String,
    /// Includes workstreams with no tasks in this Project, or no tasks at all.
    pub workstreams: Vec<String>,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Task {
    #[serde(flatten)]
    pub entry: Entry,
    pub workstreams: Vec<String>,
    /// Closing-keyword links and branch matches, including merged stacked pull requests.
    pub pull_requests: Vec<LinkedPullRequest>,
}

/// Read all repository/Project tasks, including completed tasks and archived Project items. Display
/// filtering belongs to the caller: classification always sees the full graph and external blockers.
pub fn snapshot(config: &Config, github: &GitHub<'_>, workspace: &dyn Branches) -> Result<Snapshot> {
    let workstreams = github.workstreams()?;
    let mut issues = github.project_issues()?;
    let references: Vec<_> = issues.iter().map(|issue| issue.reference.clone()).collect();
    let memberships =
        github.issue_labels_batch(&references)?.iter().map(|labels| names(labels)).collect::<Result<Vec<_>>>()?;
    let branches: Vec<_> = references.iter().map(|reference| config.branch(reference.number())).collect();
    let pull_requests = github.pull_requests_batch(&branches)?;
    let source = SnapshotIssues {
        config,
        github,
        pull_requests: RefCell::new(branches.into_iter().zip(pull_requests).collect()),
    };
    for issue in &mut issues {
        source.link_pull_requests(issue)?;
    }
    let entries = work::survey_issues(config, &source, workspace, issues.clone())?;
    let tasks = entries
        .into_iter()
        .zip(issues)
        .zip(memberships)
        .map(|((entry, issue), workstreams)| Task {
            entry,
            workstreams,
            pull_requests: issue.pull_requests.iter().map(LinkedPullRequest::from).collect(),
        })
        .collect();
    Ok(Snapshot { repo: config.repo.clone(), project_url: config.project_url.clone(), workstreams, tasks })
}

/// Cache branch lookups for this snapshot only. Mutations and later snapshots must read fresh data.
struct SnapshotIssues<'a, 'runner> {
    config: &'a Config,
    github: &'a GitHub<'runner>,
    pull_requests: RefCell<HashMap<String, Vec<PullRequest>>>,
}

impl SnapshotIssues<'_, '_> {
    fn pull_requests(&self, branch: &str) -> Result<Vec<PullRequest>> {
        if let Some(prs) = self.pull_requests.borrow().get(branch) {
            return Ok(prs.clone());
        }
        let prs = self.github.pull_requests(branch)?;
        self.pull_requests.borrow_mut().insert(branch.into(), prs.clone());
        Ok(prs)
    }

    fn link_pull_requests(&self, issue: &mut Issue) -> Result<()> {
        if issue.reference.repo().eq_ignore_ascii_case(&self.config.repo) {
            for pr in self.pull_requests(&self.config.branch(issue.reference.number()))? {
                if !issue.pull_requests.iter().any(|existing| existing.url.eq_ignore_ascii_case(&pr.url)) {
                    issue.pull_requests.push(pr);
                }
            }
        }
        issue.pull_requests.sort_by(|a, b| (&a.repo, a.number).cmp(&(&b.repo, b.number)));
        Ok(())
    }
}

impl Issues for SnapshotIssues<'_, '_> {
    fn queue(&self) -> Result<Vec<Issue>> {
        self.github.queue()
    }

    fn issue(&self, reference: &IssueRef) -> Result<Issue> {
        let mut issue = self.github.issue(reference)?;
        self.link_pull_requests(&mut issue)?;
        Ok(issue)
    }

    fn open_pull_request(&self, branch: &str) -> Result<Option<PullRequest>> {
        let mut open = self.pull_requests(branch)?.into_iter().filter(|pr| pr.state == PullRequestState::Open);
        let first = open.next();
        if open.next().is_some() {
            return Err(Error::msg(format!("More than one open pull request from {branch}. Close the extras.")));
        }
        Ok(first)
    }
}
