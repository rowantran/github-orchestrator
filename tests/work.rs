use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use github_orchestrator::Result;
use github_orchestrator::config::Config;
use github_orchestrator::domain::{Issue, IssueRef, IssueState, PullRequest, PullRequestState, StateReason};
use github_orchestrator::work::{Branches, Issues, LinkedPullRequest, State, classify, survey};

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

fn open_pr(number: u64, head: &str, base: &str) -> PullRequest {
    PullRequest {
        number,
        url: format!("https://github.com/acme/app/pull/{number}"),
        repo: REPO.into(),
        state: PullRequestState::Open,
        draft: false,
        base: base.into(),
        head: head.into(),
        merge_commit: None,
    }
}

fn draft_pr(number: u64, head: &str, base: &str) -> PullRequest {
    PullRequest { draft: true, ..open_pr(number, head, base) }
}

struct FakeGitHub {
    queue: Vec<Issue>,
    issues: HashMap<IssueRef, Issue>,
    /// Open pull requests by head branch.
    reviews: HashMap<String, PullRequest>,
    issue_calls: RefCell<Vec<IssueRef>>,
}

impl FakeGitHub {
    fn new(queue: Vec<Issue>, others: Vec<Issue>) -> Self {
        let issues = queue.iter().chain(&others).map(|i| (i.reference.clone(), i.clone())).collect();
        FakeGitHub { queue, issues, reviews: HashMap::new(), issue_calls: RefCell::default() }
    }

    fn with_reviews(mut self, reviews: &[PullRequest]) -> Self {
        self.reviews = reviews.iter().map(|pr| (pr.head.clone(), pr.clone())).collect();
        self
    }
}

impl Issues for FakeGitHub {
    fn queue(&self) -> Result<Vec<Issue>> {
        Ok(self.queue.clone())
    }

    fn issue(&self, reference: &IssueRef) -> Result<Issue> {
        self.issue_calls.borrow_mut().push(reference.clone());
        Ok(self.issues[reference].clone())
    }

    fn open_pull_request(&self, branch: &str) -> Result<Option<PullRequest>> {
        Ok(self.reviews.get(branch).cloned())
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
        project_url: "https://github.com/users/owner/projects/1".into(),
        checkout: PathBuf::from("/nonexistent"),
        base_branch: "main".into(),
        vault: None,
        agents: Default::default(),
    }
}

fn ready() -> State {
    State::Ready { stack_on: vec![] }
}

fn stacked(on: &[u64]) -> State {
    State::Ready { stack_on: on.to_vec() }
}

fn states(items: &[github_orchestrator::work::Entry]) -> Vec<(u64, State)> {
    items.iter().map(|i| (i.number, i.state.clone())).collect()
}

#[test]
fn ready_needs_every_blocker_done_and_no_branch() {
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
    assert_eq!(
        states(&items),
        [(10, ready()), (11, ready()), (12, State::Blocked), (13, State::Blocked), (14, State::InProgress)]
    );
    assert_eq!(items[4].worktree.as_deref(), Some("/work/gh-14"));
    assert_eq!(items[0].branch, "owner/gh-10");
    assert_eq!(items[0].worktree, None);
    assert_eq!(items[0].body, "Body 10");
    // Blockers are classified like any issue.
    assert_eq!(items[1].blockers[0].state, State::Done);
    assert_eq!(items[3].blockers[0].state, State::Closed { reason: Some(StateReason::NotPlanned) });
    assert_eq!(items[2].blockers[1].state, ready());
}

#[test]
fn json_is_flat_and_tagged_by_state() {
    let github = FakeGitHub::new(vec![issue(2, &blocked_by(&[1]))], vec![closed(1, StateReason::Duplicate)]);
    let value = serde_json::to_value(survey(&config(), &github, &FakeWorkspace::default()).unwrap()).unwrap();
    assert_eq!(value[0]["state"], "blocked");
    assert_eq!(value[0]["worktree"], serde_json::Value::Null);
    assert_eq!(value[0]["blockers"][0]["state"], "closed");
    assert_eq!(value[0]["blockers"][0]["reason"], "DUPLICATE");

    let github = FakeGitHub::new(vec![issue(1, &[]), issue(2, &blocked_by(&[1])), issue(3, &[])], vec![])
        .with_reviews(&[open_pr(10, "owner/gh-1", "main")]);
    let value = serde_json::to_value(survey(&config(), &github, &FakeWorkspace::default()).unwrap()).unwrap();
    assert_eq!(value[0]["state"], "ready_for_review");
    assert_eq!(value[0]["pull_request"]["head"], "owner/gh-1");
    assert_eq!(value[1]["state"], "ready");
    assert_eq!(value[1]["stack_on"], serde_json::json!([1]));
    assert_eq!(value[1]["blockers"][0]["state"], "ready_for_review");
    assert_eq!(value[2]["stack_on"], serde_json::json!([]));
}

#[test]
fn branch_without_worktree_counts_as_in_progress() {
    let github = FakeGitHub::new(vec![issue(5, &[])], vec![]);
    let items = survey(&config(), &github, &FakeWorkspace::with(&[], &["owner/gh-5"])).unwrap();
    assert_eq!(items[0].state, State::InProgress);
    assert_eq!(items[0].worktree, None);
}

#[test]
fn blocked_issue_reports_blocker_branches_and_pull_requests() {
    type Case<'a> = (&'a [(&'a str, &'a str)], &'a [&'a str], (Option<&'a str>, Option<&'a str>), State);
    let cases: [Case; 3] = [
        (&[("owner/gh-1", "/work/gh-1")], &[], (Some("owner/gh-1"), Some("/work/gh-1")), State::InProgress),
        (&[], &["owner/gh-1"], (Some("owner/gh-1"), None), State::InProgress),
        (&[], &[], (None, None), ready()),
    ];
    for (worktrees, branches, expected, blocker_state) in cases {
        let pr = open_pr(9, "someone/feature", "main");
        let blocker = Issue { pull_requests: vec![pr.clone()], ..issue(1, &[]) };
        let github = FakeGitHub::new(vec![issue(2, &blocked_by(&[1]))], vec![blocker]);
        let items = survey(&config(), &github, &FakeWorkspace::with(worktrees, branches)).unwrap();
        let blocker = &items[0].blockers[0];
        assert_eq!(items[0].state, State::Blocked);
        assert_eq!(blocker.state, blocker_state);
        assert_eq!((blocker.branch.as_deref(), blocker.worktree.as_deref()), expected);
        assert_eq!(
            blocker.pull_requests,
            [LinkedPullRequest {
                url: pr.url,
                state: PullRequestState::Open,
                draft: false,
                head: "someone/feature".into(),
                base: "main".into()
            }]
        );
    }
}

#[test]
fn blockers_in_other_repositories_never_match_local_branches_or_pull_requests() {
    let other = Issue { reference: reference("other/repo", 1), ..issue(1, &[]) };
    let github = FakeGitHub::new(vec![issue(2, &[reference("other/repo", 1)])], vec![other]).with_reviews(&[open_pr(
        10,
        "owner/gh-1",
        "main",
    )]);
    let items = survey(&config(), &github, &FakeWorkspace::with(&[("owner/gh-1", "/work/gh-1")], &[])).unwrap();
    assert_eq!(items[0].blockers[0].branch, None);
    assert_eq!(items[0].blockers[0].repo, "other/repo");
    assert_eq!(items[0].blockers[0].state, ready()); // unblocked, and gho cannot see work in other repositories
    assert_eq!(items[0].state, State::Blocked);
}

#[test]
fn open_pull_request_from_the_branch_means_ready_for_review() {
    // With or without a local branch: the pushed branch and its pull request are what count.
    for branches in [&["owner/gh-5"][..], &[]] {
        let github = FakeGitHub::new(vec![issue(5, &[])], vec![]).with_reviews(&[open_pr(50, "owner/gh-5", "main")]);
        let items = survey(&config(), &github, &FakeWorkspace::with(&[], branches)).unwrap();
        let State::ReadyForReview { pull_request } = &items[0].state else { panic!("{:?}", items[0].state) };
        assert_eq!(
            (pull_request.url.as_str(), pull_request.head.as_str()),
            ("https://github.com/acme/app/pull/50", "owner/gh-5")
        );
    }
}

#[test]
fn draft_pull_request_from_the_branch_means_in_progress() {
    // With or without a local branch: the issue is not ready for review until the pull request is published.
    for branches in [&["owner/gh-5"][..], &[]] {
        let github = FakeGitHub::new(vec![issue(5, &[])], vec![]).with_reviews(&[draft_pr(50, "owner/gh-5", "main")]);
        let items = survey(&config(), &github, &FakeWorkspace::with(&[], branches)).unwrap();
        assert_eq!(items[0].state, State::InProgress);
    }
}

#[test]
fn blockers_with_draft_pull_requests_block_dependents() {
    let github = FakeGitHub::new(vec![issue(1, &[]), issue(2, &blocked_by(&[1]))], vec![]).with_reviews(&[draft_pr(
        10,
        "owner/gh-1",
        "main",
    )]);
    let items = survey(&config(), &github, &FakeWorkspace::default()).unwrap();
    assert_eq!(states(&items), [(1, State::InProgress), (2, State::Blocked)]);
}

#[test]
fn blockers_ready_for_review_make_dependents_ready_to_stack() {
    let queue = vec![
        issue(1, &[]),                  // ready for review, based on main
        issue(2, &blocked_by(&[1])),    // stacks on 1
        issue(3, &blocked_by(&[1, 9])), // 9 done: still stacks on 1
        issue(4, &blocked_by(&[1, 6])), // 6 not started: blocked
        issue(5, &blocked_by(&[1, 7])), // 1 and 7 are separate stacks: blocked
        issue(7, &[]),                  // ready for review, based on main
    ];
    let others = vec![closed(9, StateReason::Completed), issue(6, &[])];
    let github = FakeGitHub::new(queue, others)
        .with_reviews(&[open_pr(10, "owner/gh-1", "main"), open_pr(70, "owner/gh-7", "main")]);
    let items = survey(&config(), &github, &FakeWorkspace::with(&[("owner/gh-1", "/work/gh-1")], &[])).unwrap();
    let in_review = |n| items.iter().find(|i| i.number == n).unwrap().state.clone();
    assert!(matches!(in_review(1), State::ReadyForReview { .. }));
    assert!(matches!(in_review(7), State::ReadyForReview { .. }));
    assert_eq!(
        states(&items).into_iter().filter(|(n, _)| (2..=5).contains(n)).collect::<Vec<_>>(),
        [(2, stacked(&[1])), (3, stacked(&[1])), (4, State::Blocked), (5, State::Blocked)]
    );
    assert!(stacked(&[1]).is_ready() && !in_review(1).is_ready() && !State::Blocked.is_ready());
}

#[test]
fn blockers_on_one_chain_of_pull_requests_stack_bottom_first() {
    // 2's pull request is based on 1's branch, so 2's branch holds both: start from 2.
    let github =
        FakeGitHub::new(vec![issue(3, &blocked_by(&[2, 1]))], vec![issue(1, &[]), issue(2, &blocked_by(&[1]))])
            .with_reviews(&[open_pr(10, "owner/gh-1", "main"), open_pr(20, "owner/gh-2", "owner/gh-1")]);
    let items = survey(&config(), &github, &FakeWorkspace::default()).unwrap();
    assert_eq!(items[0].state, stacked(&[1, 2]));
    // Closing keywords do not link stacked pull requests; they are found by branch.
    assert!(items[0].blockers.iter().all(|b| b.pull_requests.is_empty()));
}

#[test]
fn chain_may_pass_through_pull_requests_of_other_issues() {
    // 3 is stacked on 2, which is stacked on 1; the dependent is blocked only by 1 and 3.
    let github = FakeGitHub::new(vec![issue(4, &blocked_by(&[1, 3]))], vec![issue(1, &[]), issue(3, &[])])
        .with_reviews(&[
            open_pr(10, "owner/gh-1", "main"),
            open_pr(20, "owner/gh-2", "owner/gh-1"),
            open_pr(30, "owner/gh-3", "owner/gh-2"),
        ]);
    let items = survey(&config(), &github, &FakeWorkspace::default()).unwrap();
    assert_eq!(items[0].state, stacked(&[1, 3]));
}

#[test]
fn closed_blockers_never_unblock() {
    let github = FakeGitHub::new(vec![issue(4, &blocked_by(&[3]))], vec![closed(3, StateReason::NotPlanned)])
        .with_reviews(&[open_pr(30, "owner/gh-3", "main")]);
    let items = survey(&config(), &github, &FakeWorkspace::default()).unwrap();
    assert_eq!(items[0].state, State::Blocked);
    assert_eq!(items[0].blockers[0].state, State::Closed { reason: Some(StateReason::NotPlanned) });
}

#[test]
fn dependency_cycles_stay_blocked() {
    let github = FakeGitHub::new(vec![issue(1, &blocked_by(&[2])), issue(2, &blocked_by(&[1]))], vec![]);
    let items = survey(&config(), &github, &FakeWorkspace::default()).unwrap();
    assert_eq!(states(&items), [(1, State::Blocked), (2, State::Blocked)]);
}

#[test]
fn queue_issues_are_not_fetched_again_as_blockers() {
    let github = FakeGitHub::new(vec![issue(1, &[]), issue(2, &blocked_by(&[1]))], vec![]);
    survey(&config(), &github, &FakeWorkspace::default()).unwrap();
    assert!(github.issue_calls.borrow().is_empty());
}

#[test]
fn classify_reports_one_issue_including_closed_ones() {
    let github =
        FakeGitHub::new(vec![], vec![issue(1, &[]), issue(2, &blocked_by(&[1])), closed(3, StateReason::Completed)])
            .with_reviews(&[open_pr(10, "owner/gh-1", "main")]);
    let workspace = FakeWorkspace::default();
    assert_eq!(classify(&config(), &github, &workspace, &reference(REPO, 2)).unwrap().state, stacked(&[1]));
    assert_eq!(classify(&config(), &github, &workspace, &reference(REPO, 3)).unwrap().state, State::Done);
}
