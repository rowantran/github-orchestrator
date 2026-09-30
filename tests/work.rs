use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use github_orchestrator::Result;
use github_orchestrator::config::Config;
use github_orchestrator::domain::{Issue, IssueRef, IssueState, PullRequest, PullRequestState, StateReason};
use github_orchestrator::work::{Branches, Issues, LinkedPullRequest, State, survey};

const REPO: &str = "acme/app";

fn reference(repo: &str, number: u64) -> IssueRef {
    IssueRef::new(repo, number).unwrap()
}

fn issue(number: u64, blockers: &[IssueRef]) -> Issue {
    Issue {
        reference: reference(REPO, number),
        title: format!("Issue {number}"),
        body: format!("Body {number}"),
        state: IssueState::Open,
        state_reason: None,
        assignees: vec![],
        project_ids: vec![],
        blockers: blockers.to_vec(),
        pull_requests: vec![],
    }
}

fn closed(number: u64, reason: StateReason) -> Issue {
    Issue { state: IssueState::Closed, state_reason: Some(reason), ..issue(number, &[]) }
}

fn blocked_by(numbers: &[u64]) -> Vec<IssueRef> {
    numbers.iter().map(|&n| reference(REPO, n)).collect()
}

struct FakeGitHub {
    queue: Vec<Issue>,
    issues: HashMap<IssueRef, Issue>,
}

impl FakeGitHub {
    fn new(queue: Vec<Issue>, others: Vec<Issue>) -> Self {
        let issues = queue.iter().chain(&others).map(|i| (i.reference.clone(), i.clone())).collect();
        FakeGitHub { queue, issues }
    }
}

impl Issues for FakeGitHub {
    fn queue(&self) -> Result<Vec<Issue>> {
        Ok(self.queue.clone())
    }

    fn issue(&self, reference: &IssueRef) -> Result<Issue> {
        Ok(self.issues[reference].clone())
    }
}

#[derive(Default)]
struct FakeWorkspace {
    worktrees: BTreeMap<String, String>,
    branches: BTreeSet<String>,
}

impl FakeWorkspace {
    fn with(worktrees: &[(&str, &str)], branches: &[&str]) -> Self {
        FakeWorkspace {
            worktrees: worktrees.iter().map(|(b, p)| (b.to_string(), p.to_string())).collect(),
            branches: branches.iter().map(|b| b.to_string()).collect(),
        }
    }
}

impl Branches for FakeWorkspace {
    fn worktrees(&self) -> Result<BTreeMap<String, String>> {
        Ok(self.worktrees.clone())
    }

    fn branch_exists(&self, branch: &str) -> Result<bool> {
        Ok(self.worktrees.contains_key(branch) || self.branches.contains(branch))
    }
}

fn config() -> Config {
    Config {
        repo: REPO.into(),
        owner: "owner".into(),
        project_id: "PVT_q".into(),
        project_url: "https://github.com/users/owner/projects/1".into(),
        checkout: PathBuf::from("/nonexistent"),
        base_branch: "main".into(),
        vault: None,
    }
}

#[test]
fn ready_needs_every_blocker_completed_and_no_branch() {
    let queue = vec![
        issue(10, &[]),
        issue(11, &blocked_by(&[1])),
        issue(12, &blocked_by(&[1, 3])),
        issue(13, &blocked_by(&[2])),
        issue(14, &blocked_by(&[1])),
    ];
    let others = vec![closed(1, StateReason::Completed), closed(2, StateReason::NotPlanned), issue(3, &[])];
    let github = FakeGitHub::new(queue, others);
    let items = survey(&config(), &github, &FakeWorkspace::with(&[("owner/gh-14", "/work/gh-14")], &[])).unwrap();
    let states: Vec<(u64, State)> = items.iter().map(|i| (i.number, i.state)).collect();
    assert_eq!(
        states,
        [(10, State::Ready), (11, State::Ready), (12, State::Blocked), (13, State::Blocked), (14, State::InProgress)]
    );
    assert_eq!(items[4].worktree.as_deref(), Some("/work/gh-14"));
    assert_eq!(items[0].branch, "owner/gh-10");
    assert_eq!(items[0].worktree, None);
    assert_eq!(items[0].body, "Body 10");
    assert_eq!(items[3].blockers[0].state_reason, Some(StateReason::NotPlanned));
}

#[test]
fn json_shape_is_stable() {
    let github = FakeGitHub::new(vec![issue(2, &blocked_by(&[1]))], vec![closed(1, StateReason::Duplicate)]);
    let items = survey(&config(), &github, &FakeWorkspace::default()).unwrap();
    let value = serde_json::to_value(&items).unwrap();
    assert_eq!(value[0]["state"], "blocked");
    assert_eq!(value[0]["worktree"], serde_json::Value::Null);
    assert_eq!(value[0]["blockers"][0]["state"], "CLOSED");
    assert_eq!(value[0]["blockers"][0]["state_reason"], "DUPLICATE");
    assert_eq!(value[0]["blockers"][0]["done"], false);
}

#[test]
fn branch_without_worktree_counts_as_in_progress() {
    let github = FakeGitHub::new(vec![issue(5, &[])], vec![]);
    let items = survey(&config(), &github, &FakeWorkspace::with(&[], &["owner/gh-5"])).unwrap();
    assert_eq!(items[0].state, State::InProgress);
    assert_eq!(items[0].worktree, None);
}

#[test]
fn blocked_issue_reports_where_to_stack() {
    type Case<'a> = (&'a [(&'a str, &'a str)], &'a [&'a str], (Option<&'a str>, Option<&'a str>));
    let cases: [Case; 3] = [
        (&[("owner/gh-1", "/work/gh-1")], &[], (Some("owner/gh-1"), Some("/work/gh-1"))),
        (&[], &["owner/gh-1"], (Some("owner/gh-1"), None)),
        (&[], &[], (None, None)),
    ];
    for (worktrees, branches, expected) in cases {
        let pr = PullRequest {
            number: 9,
            url: "https://github.com/acme/app/pull/9".into(),
            repo: REPO.into(),
            state: PullRequestState::Open,
            base: "main".into(),
            head: "someone/feature".into(),
            merge_commit: None,
        };
        let blocker = Issue { pull_requests: vec![pr.clone()], ..issue(1, &[]) };
        let github = FakeGitHub::new(vec![issue(2, &blocked_by(&[1]))], vec![blocker]);
        let items = survey(&config(), &github, &FakeWorkspace::with(worktrees, branches)).unwrap();
        let blocker = &items[0].blockers[0];
        assert_eq!(items[0].state, State::Blocked);
        assert_eq!((blocker.branch.as_deref(), blocker.worktree.as_deref()), expected);
        assert_eq!(
            blocker.pull_requests,
            [LinkedPullRequest {
                url: pr.url,
                state: PullRequestState::Open,
                head: "someone/feature".into(),
                base: "main".into()
            }]
        );
    }
}

#[test]
fn blockers_in_other_repositories_never_match_local_branches() {
    let other = Issue { reference: reference("other/repo", 1), ..issue(1, &[]) };
    let github = FakeGitHub::new(vec![issue(2, &[reference("other/repo", 1)])], vec![other]);
    let items = survey(&config(), &github, &FakeWorkspace::with(&[("owner/gh-1", "/work/gh-1")], &[])).unwrap();
    assert_eq!(items[0].blockers[0].branch, None);
    assert_eq!(items[0].blockers[0].repo, "other/repo");
}
