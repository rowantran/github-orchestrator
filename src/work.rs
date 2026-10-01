//! Classify issues as blocked, ready, in progress, ready for review, done or closed.
//! Reads GitHub and git; changes nothing.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Serialize;

use crate::Result;
use crate::config::Config;
use crate::domain::{Issue, IssueRef, IssueState, PullRequest, PullRequestState, StateReason};
use crate::github::GitHub;
use crate::workspace::Workspace;

/// Where issues come from. Implemented by [`GitHub`]; tests use fixtures.
pub trait Issues {
    fn queue(&self) -> Result<Vec<Issue>>;
    fn issue(&self, reference: &IssueRef) -> Result<Issue>;
    /// The open pull request from `branch` in the configured repository, if any.
    fn open_pull_request(&self, branch: &str) -> Result<Option<PullRequest>>;
}

impl Issues for GitHub<'_> {
    fn queue(&self) -> Result<Vec<Issue>> {
        GitHub::queue(self)
    }

    fn issue(&self, reference: &IssueRef) -> Result<Issue> {
        GitHub::issue(self, reference)
    }

    fn open_pull_request(&self, branch: &str) -> Result<Option<PullRequest>> {
        GitHub::open_pull_request(self, branch)
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

/// An issue's place in the workflow. Serialized flat: `{"state": "ready", "stack_on": [41], ...}`.
///
/// Only issues in the configured repository have gho branches, so issues elsewhere are never
/// `in_progress` or `ready_for_review` as far as gho can see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum State {
    /// Open, no branch, and some blocker is neither done nor usable to stack on.
    Blocked,
    /// Open, no branch, and every blocker is done or ready for review. Can be started now.
    /// `stack_on` lists the blockers that are ready for review, bottom of the stack first; the new
    /// branch starts from the last one's branch. Empty: start from the base branch.
    Ready { stack_on: Vec<u64> },
    /// The issue's branch exists (gho worktree ran, or someone made it by hand) with no published pull
    /// request, or an open draft pull request comes from it.
    InProgress,
    /// An open pull request that is not a draft comes from the issue's branch.
    ReadyForReview { pull_request: LinkedPullRequest },
    /// Closed as completed.
    Done,
    /// Closed as not planned or duplicate. Never unblocks dependents.
    Closed { reason: Option<StateReason> },
}

impl State {
    pub fn label(&self) -> &'static str {
        match self {
            State::Blocked => "BLOCKED",
            State::Ready { .. } => "READY",
            State::InProgress => "IN_PROGRESS",
            State::ReadyForReview { .. } => "READY_FOR_REVIEW",
            State::Done => "DONE",
            State::Closed { .. } => "CLOSED",
        }
    }

    /// Work that can be picked up and scheduled now.
    pub fn is_ready(&self) -> bool {
        matches!(self, State::Ready { .. })
    }
}

/// One issue, as printed by `gho ready --json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub number: u64,
    pub title: String,
    pub url: String,
    #[serde(flatten)]
    pub state: State,
    pub branch: String,
    pub worktree: Option<String>,
    pub blockers: Vec<Blocker>,
    pub body: String,
}

/// A blocker, classified like any issue, with its local branch and pull requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocker {
    pub number: u64,
    pub repo: String,
    pub url: String,
    pub title: String,
    #[serde(flatten)]
    pub state: State,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    /// Pull requests that close this issue. Stacked pull requests are not listed: GitHub only links
    /// closing keywords on pull requests into the default branch.
    pub pull_requests: Vec<LinkedPullRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkedPullRequest {
    pub url: String,
    pub state: PullRequestState,
    pub draft: bool,
    pub head: String,
    pub base: String,
}

impl From<&PullRequest> for LinkedPullRequest {
    fn from(pr: &PullRequest) -> Self {
        LinkedPullRequest {
            url: pr.url.clone(),
            state: pr.state,
            draft: pr.draft,
            head: pr.head.clone(),
            base: pr.base.clone(),
        }
    }
}

/// Classify every open queue issue.
pub fn survey(config: &Config, github: &dyn Issues, workspace: &dyn Branches) -> Result<Vec<Entry>> {
    let queue = github.queue()?;
    let mut classifier = Classifier::new(config, github, workspace)?;
    // Blockers are often queue issues too; do not fetch them twice.
    classifier.issues.extend(queue.iter().map(|issue| (issue.reference.clone(), issue.clone())));
    queue.into_iter().map(|issue| classifier.entry(issue)).collect()
}

/// Classify one issue, for example before creating its worktree.
pub fn classify(config: &Config, github: &dyn Issues, workspace: &dyn Branches, reference: &IssueRef) -> Result<Entry> {
    let issue = github.issue(reference)?;
    Classifier::new(config, github, workspace)?.entry(issue)
}

/// Reads GitHub and git once per issue or branch.
struct Classifier<'a> {
    config: &'a Config,
    github: &'a dyn Issues,
    workspace: &'a dyn Branches,
    repo: String,
    worktrees: BTreeMap<String, String>,
    issues: HashMap<IssueRef, Issue>,
    reviews: HashMap<u64, Option<LinkedPullRequest>>,
    states: HashMap<IssueRef, State>,
    /// Issues being classified, to stop at dependency cycles.
    visiting: HashSet<IssueRef>,
}

impl<'a> Classifier<'a> {
    fn new(config: &'a Config, github: &'a dyn Issues, workspace: &'a dyn Branches) -> Result<Self> {
        Ok(Classifier {
            config,
            github,
            workspace,
            repo: config.repo.to_lowercase(),
            worktrees: workspace.worktrees()?,
            issues: HashMap::new(),
            reviews: HashMap::new(),
            states: HashMap::new(),
            visiting: HashSet::new(),
        })
    }

    fn issue(&mut self, reference: &IssueRef) -> Result<Issue> {
        if let Some(issue) = self.issues.get(reference) {
            return Ok(issue.clone());
        }
        let issue = self.github.issue(reference)?;
        self.issues.insert(reference.clone(), issue.clone());
        Ok(issue)
    }

    /// The issue's local branch and worktree, if the branch exists. Only this repository has local branches.
    fn local(&self, reference: &IssueRef) -> Result<(Option<String>, Option<String>)> {
        if reference.repo() != self.repo {
            return Ok((None, None));
        }
        let branch = self.config.branch(reference.number());
        if let Some(path) = self.worktrees.get(&branch) {
            return Ok((Some(branch), Some(path.clone())));
        }
        Ok(if self.workspace.branch_exists(&branch)? { (Some(branch), None) } else { (None, None) })
    }

    /// The open pull request (draft or not) from issue `number`'s branch in this repository.
    fn review(&mut self, number: u64) -> Result<Option<LinkedPullRequest>> {
        if let Some(review) = self.reviews.get(&number) {
            return Ok(review.clone());
        }
        let review = self.github.open_pull_request(&self.config.branch(number))?.as_ref().map(LinkedPullRequest::from);
        self.reviews.insert(number, review.clone());
        Ok(review)
    }

    /// The issue number whose gho branch is `branch`, if it is one.
    fn branch_issue(&self, branch: &str) -> Option<u64> {
        let number = branch.strip_prefix(&format!("{}/gh-", self.config.owner))?;
        number.parse().ok().filter(|n| self.config.branch(*n) == branch)
    }

    fn state(&mut self, issue: &Issue) -> Result<State> {
        if let Some(state) = self.states.get(&issue.reference) {
            return Ok(state.clone());
        }
        if !self.visiting.insert(issue.reference.clone()) {
            return Ok(State::Blocked); // A dependency cycle never becomes ready.
        }
        let state = self.compute(issue);
        self.visiting.remove(&issue.reference);
        let state = state?;
        self.states.insert(issue.reference.clone(), state.clone());
        Ok(state)
    }

    fn compute(&mut self, issue: &Issue) -> Result<State> {
        if issue.state == IssueState::Closed {
            return Ok(if issue.completed() { State::Done } else { State::Closed { reason: issue.state_reason } });
        }
        let local = issue.reference.repo() == self.repo;
        if local && let Some(pull_request) = self.review(issue.reference.number())? {
            // A draft is still being worked on, so it neither counts as review nor unblocks dependents.
            return Ok(if pull_request.draft { State::InProgress } else { State::ReadyForReview { pull_request } });
        }
        if self.local(&issue.reference)?.0.is_some() {
            return Ok(State::InProgress);
        }
        let mut in_review = BTreeMap::new();
        for reference in &issue.blockers {
            let blocker = self.issue(reference)?;
            match self.state(&blocker)? {
                State::Done => {}
                State::ReadyForReview { pull_request } => {
                    in_review.insert(reference.number(), pull_request);
                }
                _ => return Ok(State::Blocked),
            }
        }
        Ok(match self.stack(&in_review)? {
            Some(stack_on) => State::Ready { stack_on },
            None => State::Blocked,
        })
    }

    /// Order blockers that are ready for review into one stack, bottom first. `None` when they are not
    /// all on one chain of pull requests (each based on the branch below it), because a new branch can
    /// only start from one of them. The chain may pass through pull requests of other issues.
    fn stack(&mut self, in_review: &BTreeMap<u64, LinkedPullRequest>) -> Result<Option<Vec<u64>>> {
        for (&tip, pull_request) in in_review {
            let mut chain = vec![tip];
            let mut base = pull_request.base.clone();
            let mut seen = BTreeSet::from([tip]);
            while let Some(number) = self.branch_issue(&base)
                && seen.insert(number)
                && let Some(below) = self.review(number)?
            {
                if in_review.contains_key(&number) {
                    chain.push(number);
                }
                base = below.base;
            }
            if chain.len() == in_review.len() {
                chain.reverse();
                return Ok(Some(chain));
            }
        }
        Ok(in_review.is_empty().then(Vec::new))
    }

    fn entry(&mut self, issue: Issue) -> Result<Entry> {
        let mut blockers = Vec::new();
        for reference in &issue.blockers {
            let blocker = self.issue(reference)?;
            let state = self.state(&blocker)?;
            let (branch, worktree) = self.local(reference)?;
            blockers.push(Blocker {
                number: reference.number(),
                repo: reference.repo().into(),
                url: reference.url(),
                title: blocker.title.clone(),
                state,
                branch,
                worktree,
                pull_requests: blocker.pull_requests.iter().map(LinkedPullRequest::from).collect(),
            });
        }
        let state = self.state(&issue)?;
        let (branch, worktree) = self.local(&issue.reference)?;
        Ok(Entry {
            number: issue.reference.number(),
            title: issue.title,
            url: issue.reference.url(),
            state,
            branch: branch.unwrap_or_else(|| self.config.branch(issue.reference.number())),
            worktree,
            blockers,
            body: issue.body,
        })
    }
}
