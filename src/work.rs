//! Classify queue issues as ready, blocked or in progress. Reads GitHub and git; changes nothing.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::Result;
use crate::config::Config;
use crate::domain::{Issue, IssueRef, IssueState, PullRequestState, StateReason};
use crate::github::GitHub;
use crate::workspace::Workspace;

/// Where issues come from. Implemented by [`GitHub`]; tests use fixtures.
pub trait Issues {
    fn queue(&self) -> Result<Vec<Issue>>;
    fn issue(&self, reference: &IssueRef) -> Result<Issue>;
}

impl Issues for GitHub<'_> {
    fn queue(&self) -> Result<Vec<Issue>> {
        GitHub::queue(self)
    }

    fn issue(&self, reference: &IssueRef) -> Result<Issue> {
        GitHub::issue(self, reference)
    }
}

/// Local work in progress. Implemented by [`Workspace`]; tests use fixtures.
pub trait Branches {
    /// Branch name → worktree path.
    fn worktrees(&self) -> Result<BTreeMap<String, String>>;
    fn branch_exists(&self, branch: &str) -> Result<bool>;
}

impl Branches for Workspace<'_> {
    fn worktrees(&self) -> Result<BTreeMap<String, String>> {
        Workspace::worktrees(self)
    }

    fn branch_exists(&self, branch: &str) -> Result<bool> {
        Workspace::branch_exists(self, branch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Every blocker is closed as completed, and there is no branch yet.
    Ready,
    /// Some blocker is not closed as completed.
    Blocked,
    /// The issue's branch exists (gho worktree ran, or someone made it by hand).
    InProgress,
}

impl State {
    pub fn label(self) -> &'static str {
        match self {
            State::Ready => "READY",
            State::Blocked => "BLOCKED",
            State::InProgress => "IN_PROGRESS",
        }
    }
}

/// One open queue issue, as printed by `gho ready --json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: State,
    pub branch: String,
    pub worktree: Option<String>,
    pub blockers: Vec<Blocker>,
    pub body: String,
}

/// A blocker, with the local branch or pull requests to stack on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocker {
    pub number: u64,
    pub repo: String,
    pub url: String,
    pub title: String,
    pub done: bool,
    pub state: IssueState,
    pub state_reason: Option<StateReason>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub pull_requests: Vec<LinkedPullRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkedPullRequest {
    pub url: String,
    pub state: PullRequestState,
    pub head: String,
    pub base: String,
}

/// Classify every open queue issue.
pub fn survey(config: &Config, github: &dyn Issues, workspace: &dyn Branches) -> Result<Vec<Entry>> {
    let worktrees = workspace.worktrees()?;
    let repo = config.repo.to_lowercase();
    // The issue's local branch and worktree, if the branch exists. Only this repository has local branches.
    let local = |reference: &IssueRef| -> Result<(Option<String>, Option<String>)> {
        if reference.repo() != repo {
            return Ok((None, None));
        }
        let branch = config.branch(reference.number());
        if let Some(path) = worktrees.get(&branch) {
            return Ok((Some(branch), Some(path.clone())));
        }
        Ok(if workspace.branch_exists(&branch)? { (Some(branch), None) } else { (None, None) })
    };

    let mut blocker_issues: HashMap<IssueRef, Issue> = HashMap::new();
    let mut result = Vec::new();
    for issue in github.queue()? {
        let mut blockers = Vec::new();
        for reference in &issue.blockers {
            if !blocker_issues.contains_key(reference) {
                blocker_issues.insert(reference.clone(), github.issue(reference)?);
            }
            let blocker = &blocker_issues[reference];
            let (branch, worktree) = local(reference)?;
            blockers.push(Blocker {
                number: reference.number(),
                repo: reference.repo().into(),
                url: reference.url(),
                title: blocker.title.clone(),
                done: blocker.completed(),
                state: blocker.state,
                state_reason: blocker.state_reason,
                branch,
                worktree,
                pull_requests: blocker
                    .pull_requests
                    .iter()
                    .map(|pr| LinkedPullRequest {
                        url: pr.url.clone(),
                        state: pr.state,
                        head: pr.head.clone(),
                        base: pr.base.clone(),
                    })
                    .collect(),
            });
        }
        let (branch, worktree) = local(&issue.reference)?;
        let state = if branch.is_some() {
            State::InProgress
        } else if blockers.iter().all(|blocker| blocker.done) {
            State::Ready
        } else {
            State::Blocked
        };
        result.push(Entry {
            number: issue.reference.number(),
            title: issue.title,
            url: issue.reference.url(),
            state,
            branch: branch.unwrap_or_else(|| config.branch(issue.reference.number())),
            worktree,
            blockers,
            body: issue.body,
        });
    }
    Ok(result)
}
