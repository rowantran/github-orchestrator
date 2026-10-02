//! `gho wait` tests: agent status files in temporary directories and a fixture in place of GitHub.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use chrono::{DateTime, Utc};
use clap::Parser;
use github_orchestrator::agents::{self, Activity, Mode, Target};
use github_orchestrator::cli::Cli;
use github_orchestrator::config::{Agents, Config};
use github_orchestrator::github::GitHub;
use github_orchestrator::process::{Cmd, Runner};
use github_orchestrator::reviews::{
    self, PullRequestReviews, PullRequestStatus, RestState, Review, ReviewComment, User, by_agent,
};
use github_orchestrator::wait::{Schedule, poll};
use github_orchestrator::{Error, Result};
use serde_json::{Value, json};
use tempfile::TempDir;

const PROJECT: &str = "https://github.com/users/Owner/projects/1";

fn config(checkout: &Path) -> Config {
    Config {
        repo: "acme/app".into(),
        owner: "Owner".into(),
        project_url: PROJECT.into(),
        checkout: checkout.to_path_buf(),
        base_branch: "main".into(),
        vault: None,
        agents: Agents::default(),
    }
}

fn time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc)
}

const NOW: &str = "2026-01-01T00:10:00.000Z";

fn write_status(worktree: &Path, name: &str, state: &str, since: &str, updated_at: &str) {
    let dir = worktree.join(".gho/agents");
    fs::create_dir_all(&dir).unwrap();
    let status = json!({
        "version": 1, "agent": name, "state": state, "since": since, "updated_at": updated_at,
        "pid": 1, "session_file": "/sessions/s.jsonl", "last_message": "Opened the draft PR.",
    });
    fs::write(dir.join(format!("{name}.json")), status.to_string()).unwrap();
}

/// Two issue worktrees and one unrelated worktree, as `git worktree list` would report them.
struct Worktrees {
    _dir: TempDir,
    root: PathBuf,
    map: BTreeMap<String, String>,
}

fn worktrees() -> Worktrees {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut map = BTreeMap::new();
    for (branch, name) in [("Owner/gh-7", "seven"), ("Owner/gh-8", "eight"), ("main", "main"), ("Owner/gh-07", "x")] {
        fs::create_dir(root.join(name)).unwrap();
        map.insert(branch.to_string(), root.join(name).to_string_lossy().into_owned());
    }
    Worktrees { _dir: dir, root, map }
}

fn watch(config: &Config, targets: &[&str], mode: Mode, since: &str) -> agents::Watch<'static> {
    let config: &'static Config = Box::leak(Box::new(config.clone()));
    let targets = targets.iter().map(|t| Target::parse(t).unwrap()).collect();
    agents::Watch::new(config, targets, mode, agents::Cursor::parse(since).unwrap())
}

#[test]
fn targets_and_cursors_parse_strictly() {
    assert_eq!(Target::parse("42").unwrap(), Target { issue: 42, agent: None });
    assert_eq!(Target::parse("#42/reviewer").unwrap(), Target { issue: 42, agent: Some("reviewer".into()) });
    for bad in ["", "0", "x", "42/", "42/Reviewer", "42/../x", "-1"] {
        assert!(Target::parse(bad).is_err(), "{bad}");
    }
    let cursor = "7/implementer=2026-01-01T00:00:00.000Z,8/reviewer=2026-01-01T00:01:00Z";
    assert_eq!(agents::Cursor::parse(cursor).unwrap().to_string(), cursor);
    assert_eq!(agents::Cursor::parse("start").unwrap().to_string(), "start");
    for bad in ["", "7=2026-01-01T00:00:00Z", "7/implementer=yesterday", "7/implementer"] {
        assert!(agents::Cursor::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn any_mode_ends_on_each_new_settling_and_the_cursor_skips_reported_ones() {
    let trees = worktrees();
    let config = config(&trees.root);
    let seven = trees.root.join("seven");
    let eight = trees.root.join("eight");
    write_status(&seven, "implementer", "settled", "2026-01-01T00:09:00.000Z", "2026-01-01T00:09:59.000Z");
    write_status(&eight, "implementer", "working", "2026-01-01T00:08:00.000Z", "2026-01-01T00:09:59.000Z");
    // Agents in worktrees that are not issue branches are not watched.
    write_status(&trees.root.join("main"), "implementer", "settled", NOW, NOW);
    write_status(&trees.root.join("x"), "implementer", "settled", NOW, NOW);

    let first = watch(&config, &[], Mode::Any, "start");
    let (mut agents, missing) = first.observe(&trees.map, time(NOW)).unwrap();
    assert!(missing.is_empty());
    assert_eq!(agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["7/implementer", "8/implementer"]);
    assert!(first.decide(&mut agents, &missing, Duration::ZERO).unwrap());
    let outcome = first.outcome(agents::End::Settled, agents);
    assert!(outcome.agents[0].new && !outcome.agents[1].new);
    assert_eq!(outcome.agents[0].last_message.as_deref(), Some("Opened the draft PR."));
    assert_eq!(outcome.agents[1].last_message, None);
    assert_eq!(outcome.cursor, "7/implementer=2026-01-01T00:09:00.000Z");
    let value = serde_json::to_value(&outcome).unwrap();
    assert_eq!(value["result"], "settled");
    assert_eq!(value["agents"][0]["state"], "settled");

    // With that cursor, issue 7 still being settled does not end the next wait; issue 8 settling does.
    let next = watch(&config, &[], Mode::Any, &outcome.cursor);
    let (mut agents, missing) = next.observe(&trees.map, time(NOW)).unwrap();
    assert!(!next.decide(&mut agents, &missing, Duration::ZERO).unwrap());
    write_status(&eight, "implementer", "prompting", "2026-01-01T00:09:30.000Z", "2026-01-01T00:09:59.000Z");
    let (mut agents, missing) = next.observe(&trees.map, time(NOW)).unwrap();
    assert!(next.decide(&mut agents, &missing, Duration::ZERO).unwrap());
    assert_eq!(agents.iter().filter(|a| a.new).map(|a| a.id.as_str()).collect::<Vec<_>>(), ["8/implementer"]);

    // Settling again, after more work, is a new event.
    write_status(&seven, "implementer", "settled", "2026-01-01T00:09:40.000Z", "2026-01-01T00:09:59.000Z");
    let (mut agents, missing) = next.observe(&trees.map, time(NOW)).unwrap();
    assert!(next.decide(&mut agents, &missing, Duration::ZERO).unwrap());
    assert!(agents[0].new);
}

#[test]
fn all_mode_waits_for_every_target_and_targets_select_agents() {
    let trees = worktrees();
    let config = config(&trees.root);
    let seven = trees.root.join("seven");
    write_status(&seven, "implementer", "settled", "2026-01-01T00:09:00.000Z", "2026-01-01T00:09:59.000Z");
    write_status(&seven, "reviewer", "working", "2026-01-01T00:09:00.000Z", "2026-01-01T00:09:59.000Z");

    let all = watch(&config, &["7"], Mode::All, "start");
    let (mut agents, missing) = all.observe(&trees.map, time(NOW)).unwrap();
    assert_eq!(agents.len(), 2);
    assert!(!all.decide(&mut agents, &missing, Duration::ZERO).unwrap());

    let one = watch(&config, &["7/implementer", "7/implementer"], Mode::All, "start");
    let (mut agents, missing) = one.observe(&trees.map, time(NOW)).unwrap();
    assert_eq!(agents.len(), 1);
    assert!(one.decide(&mut agents, &missing, Duration::ZERO).unwrap());

    write_status(&seven, "reviewer", "exited", "2026-01-01T00:09:30.000Z", "2026-01-01T00:09:30.000Z");
    let (mut agents, missing) = all.observe(&trees.map, time(NOW)).unwrap();
    assert!(all.decide(&mut agents, &missing, Duration::ZERO).unwrap());
}

#[test]
fn a_status_that_stops_updating_is_lost() {
    let trees = worktrees();
    let config = config(&trees.root);
    let seven = trees.root.join("seven");
    write_status(&seven, "implementer", "working", "2026-01-01T00:00:00.000Z", "2026-01-01T00:08:59.000Z");
    let wait = watch(&config, &["7"], Mode::Any, "start");
    let (mut agents, missing) = wait.observe(&trees.map, time(NOW)).unwrap();
    assert_eq!(agents[0].state, Activity::Lost);
    assert!(wait.decide(&mut agents, &missing, Duration::ZERO).unwrap());
    assert_eq!(wait.outcome(agents::End::Settled, agents).cursor, "7/implementer=2026-01-01T00:08:59.000Z");
    // An agent that quit is not lost, however old its status.
    write_status(&seven, "implementer", "exited", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    let (agents, _) = wait.observe(&trees.map, time(NOW)).unwrap();
    assert_eq!(agents[0].state, Activity::Exited);
}

#[test]
fn missing_statuses_are_tolerated_only_while_agents_start() {
    let trees = worktrees();
    let config = config(&trees.root);
    let wait = watch(&config, &["7/reviewer"], Mode::Any, "start");
    let (mut agents, missing) = wait.observe(&trees.map, time(NOW)).unwrap();
    assert_eq!(missing, ["7/reviewer"]);
    assert!(!wait.decide(&mut agents, &missing, Duration::from_secs(1)).unwrap());
    let error = wait.decide(&mut agents, &missing, agents::STARTUP).unwrap_err().to_string();
    assert!(error.contains("No agent status for 7/reviewer") && error.contains("--gho-agent"), "{error}");

    let everything = watch(&config, &[], Mode::Any, "start");
    let (_, missing) = everything.observe(&trees.map, time(NOW)).unwrap();
    assert_eq!(missing, ["any agent"]);

    let error = watch(&config, &["9"], Mode::Any, "start").observe(&trees.map, time(NOW)).unwrap_err();
    assert!(error.to_string().contains("Issue #9 has no worktree"), "{error}");
}

#[test]
fn invalid_status_files_are_errors_and_temporary_files_are_skipped() {
    let trees = worktrees();
    let config = config(&trees.root);
    let dir = trees.root.join("seven/.gho/agents");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("implementer.json.123.tmp"), "{").unwrap();
    let wait = watch(&config, &["7"], Mode::Any, "start");
    assert_eq!(wait.observe(&trees.map, time(NOW)).unwrap().1, ["7"]);
    for text in [
        "{",
        r#"{"version":2,"agent":"implementer","state":"settled","since":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#,
        r#"{"version":1,"agent":"reviewer","state":"settled","since":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#,
        r#"{"version":1,"agent":"implementer","state":"asleep","since":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#,
        r#"{"version":1,"agent":"implementer","state":"settled","since":"later","updated_at":"2026-01-01T00:00:00Z"}"#,
    ] {
        fs::write(dir.join("implementer.json"), text).unwrap();
        assert!(wait.observe(&trees.map, time(NOW)).is_err(), "{text}");
    }
}

#[test]
fn poll_retries_failures_after_a_success_and_times_out() {
    let schedule = Schedule { interval: Duration::from_millis(1), timeout: Some(Duration::from_millis(50)) };
    let calls = Cell::new(0);
    let result = poll(&schedule, || {
        calls.set(calls.get() + 1);
        match calls.get() {
            1 => Ok(None),
            2..=4 => Err(Error::msg("network")),
            _ => Ok(Some(calls.get())),
        }
    });
    assert_eq!(result.unwrap(), Some(5));

    let first = poll(&schedule, || Err::<Option<()>, _>(Error::msg("bad argument")));
    assert_eq!(first.unwrap_err().to_string(), "bad argument");

    let calls = Cell::new(0);
    let failing = poll(&schedule, || {
        calls.set(calls.get() + 1);
        if calls.get() == 1 { Ok(None) } else { Err::<Option<()>, _>(Error::msg("down")) }
    });
    assert!(failing.is_err());
    assert_eq!(calls.get(), 2 + github_orchestrator::wait::RETRIES as usize);

    assert_eq!(poll(&schedule, || Ok(None::<()>)).unwrap(), None);
}

/// A pull request with reviews, as GitHub would return them.
struct FakeReviews {
    status: RefCell<PullRequestStatus>,
    reviews: RefCell<Vec<Review>>,
    comments: RefCell<Vec<ReviewComment>>,
    comment_reads: Cell<usize>,
}

impl PullRequestReviews for FakeReviews {
    fn pull_request_status(&self, _number: u64) -> Result<PullRequestStatus> {
        Ok(self.status.borrow().clone())
    }
    fn reviews(&self, _number: u64) -> Result<Vec<Review>> {
        Ok(self.reviews.borrow().clone())
    }
    fn review_comments(&self, _number: u64) -> Result<Vec<ReviewComment>> {
        self.comment_reads.set(self.comment_reads.get() + 1);
        Ok(self.comments.borrow().clone())
    }
}

fn fake() -> FakeReviews {
    FakeReviews {
        status: RefCell::new(PullRequestStatus {
            number: 5,
            html_url: "https://github.com/acme/app/pull/5".into(),
            state: RestState::Open,
            merged: false,
            draft: true,
        }),
        reviews: RefCell::new(Vec::new()),
        comments: RefCell::new(Vec::new()),
        comment_reads: Cell::new(0),
    }
}

fn review(id: u64, state: &str, body: &str, submitted_at: Option<&str>) -> Review {
    Review {
        id,
        user: Some(User { login: "Owner".into() }),
        body: body.into(),
        state: state.into(),
        submitted_at: submitted_at.map(String::from),
        html_url: format!("https://github.com/acme/app/pull/5#pullrequestreview-{id}"),
    }
}

fn comment(id: u64, review: u64, body: &str) -> ReviewComment {
    ReviewComment {
        id,
        pull_request_review_id: Some(review),
        in_reply_to_id: None,
        path: "src/lib.rs".into(),
        line: Some(3),
        original_line: Some(3),
        body: body.into(),
        html_url: format!("https://github.com/acme/app/pull/5#discussion_r{id}"),
    }
}

#[test]
fn agent_reviews_are_recognized_by_their_prefix() {
    let reply = review(1, "COMMENTED", "", Some("2026-01-01T00:00:00Z"));
    assert!(by_agent(&reply, &[&comment(10, 1, "[agent:] Done in abc123.")]));
    assert!(!by_agent(&reply, &[&comment(10, 1, "[agent:] Done."), &comment(11, 1, "Not this one")]));
    assert!(!by_agent(&reply, &[]));
    let summary = review(2, "COMMENTED", "  [agent:] Replied to all comments.", Some("2026-01-01T00:00:00Z"));
    assert!(by_agent(&summary, &[&comment(12, 2, "anything")]));
    assert!(!by_agent(&review(3, "COMMENTED", "Looks good, go ahead.", None), &[]));
}

#[test]
fn review_cursors_round_trip_and_handle_reviews_in_the_same_second() {
    let cursor = reviews::Cursor::parse("2026-01-01T00:00:05Z,3,4").unwrap();
    assert_eq!(cursor.to_string(), "2026-01-01T00:00:05Z,3,4");
    assert!(cursor.covers(time("2026-01-01T00:00:04Z"), 99));
    assert!(cursor.covers(time("2026-01-01T00:00:05Z"), 3));
    assert!(!cursor.covers(time("2026-01-01T00:00:05Z"), 5));
    assert!(!cursor.covers(time("2026-01-01T00:00:06Z"), 3));
    assert!(!reviews::Cursor::parse("start").unwrap().covers(time("2000-01-01T00:00:00Z"), 1));
    for bad in ["", "2026-01-01T00:00:05Z", "2026-01-01T00:00:05Z,x", "3,4"] {
        assert!(reviews::Cursor::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_submitted_review_ends_the_wait_with_all_its_comments() {
    let github = fake();
    let mut watch = reviews::Watch::new(&github, 5, reviews::Cursor::default());
    // A pending review (comments not yet submitted) does not end the wait.
    github.reviews.borrow_mut().push(review(1, "PENDING", "", None));
    assert_eq!(watch.check().unwrap(), None);
    assert_eq!(github.comment_reads.get(), 0);

    // The agent's reply to a thread is a one-comment review; it does not end the wait either.
    github.reviews.borrow_mut().push(review(2, "COMMENTED", "", Some("2026-01-01T00:00:05Z")));
    github.comments.borrow_mut().push(comment(20, 2, "[agent:] Fixed in abc123."));
    assert_eq!(watch.check().unwrap(), None);
    assert_eq!(watch.check().unwrap(), None);
    assert_eq!(github.comment_reads.get(), 1, "agent reviews are classified once");

    // The user submits the pending review: one batch.
    let mut submitted = review(1, "COMMENTED", "A few things.", Some("2026-01-01T00:00:05Z"));
    submitted.id = 3;
    github.reviews.borrow_mut()[0] = submitted;
    let mut reply = comment(31, 3, "And this.");
    reply.in_reply_to_id = Some(20);
    reply.line = None;
    github.comments.borrow_mut().extend([comment(30, 3, "Rename this."), reply]);
    let outcome = watch.check().unwrap().unwrap();
    assert_eq!(outcome.result, reviews::End::Reviews);
    assert_eq!(outcome.reviews.len(), 1);
    assert_eq!(outcome.reviews[0].body, "A few things.");
    assert_eq!(outcome.reviews[0].comments.len(), 2);
    assert_eq!(outcome.reviews[0].comments[1].in_reply_to, Some(20));
    assert!(outcome.reviews[0].comments[1].outdated);
    assert_eq!(outcome.reviews[0].comments[1].line, Some(3));
    assert_eq!(outcome.cursor, "2026-01-01T00:00:05Z,2,3");
    assert_eq!(outcome.pull_request.url, "https://github.com/acme/app/pull/5");
    let value = serde_json::to_value(&outcome).unwrap();
    assert_eq!(value["result"], "reviews");

    // The next wait, from that cursor, ignores these reviews; a dismissed review never counts.
    let mut next = reviews::Watch::new(&github, 5, reviews::Cursor::parse(&outcome.cursor).unwrap());
    github.reviews.borrow_mut().push(review(4, "DISMISSED", "x", Some("2026-01-01T00:01:00Z")));
    assert_eq!(next.check().unwrap(), None);
    assert_eq!(next.timed_out().result, reviews::End::Timeout);
    assert_eq!(next.timed_out().cursor, outcome.cursor);

    github.reviews.borrow_mut().push(review(5, "COMMENTED", "Approved, implement it.", Some("2026-01-01T00:02:00Z")));
    let outcome = next.check().unwrap().unwrap();
    assert_eq!(outcome.reviews.iter().map(|r| r.id).collect::<Vec<_>>(), [5]);
}

#[test]
fn a_merged_or_closed_pull_request_ends_the_wait() {
    let github = fake();
    github.status.borrow_mut().state = RestState::Closed;
    let outcome = reviews::Watch::new(&github, 5, reviews::Cursor::default()).check().unwrap().unwrap();
    assert_eq!(outcome.result, reviews::End::Closed);
    github.status.borrow_mut().merged = true;
    let outcome = reviews::Watch::new(&github, 5, reviews::Cursor::default()).check().unwrap().unwrap();
    assert_eq!(outcome.result, reviews::End::Merged);
}

/// Answers the REST calls `gho wait review` makes.
struct RestRunner {
    calls: RefCell<Vec<Vec<String>>>,
}

impl Runner for RestRunner {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        self.calls.borrow_mut().push(cmd.argv.clone());
        let endpoint = cmd.argv.get(4).map(String::as_str).unwrap_or_default();
        let value: Value = match endpoint {
            // Pull request 6 answers as 5, to check the number.
            "repos/acme/app/pulls/5" | "repos/acme/app/pulls/6" => json!({
                "number": 5, "html_url": "https://github.com/acme/app/pull/5", "state": "open",
                "merged": false, "draft": false, "title": "ignored",
            }),
            "repos/acme/app/pulls/5/reviews?per_page=100" => json!([[
                {"id": 1, "user": {"login": "Owner"}, "body": null, "state": "COMMENTED",
                 "submitted_at": "2026-01-01T00:00:00Z", "html_url": "https://github.com/acme/app/pull/5#r1"}
            ], [
                {"id": 2, "user": null, "body": "", "state": "PENDING",
                 "html_url": "https://github.com/acme/app/pull/5#r2"}
            ]]),
            "repos/acme/app/pulls/5/comments?per_page=100" => json!([[
                {"id": 10, "pull_request_review_id": 1, "in_reply_to_id": null, "path": "a.rs", "line": null,
                 "original_line": 4, "body": "Why?", "html_url": "https://github.com/acme/app/pull/5#c10"}
            ]]),
            _ => panic!("Unexpected command: {:?}", cmd.argv),
        };
        Ok(value.to_string())
    }
}

#[test]
fn github_reads_pull_request_reviews_over_rest() {
    let runner = RestRunner { calls: RefCell::new(Vec::new()) };
    let github = GitHub::new("acme/app", PROJECT, "Owner", &runner).unwrap();
    let status = github.pull_request_status(5).unwrap();
    assert_eq!((status.number, status.state, status.draft), (5, RestState::Open, false));
    let reviews = github.reviews(5).unwrap();
    assert_eq!(reviews.len(), 2);
    assert_eq!((reviews[0].body.as_str(), reviews[1].user.as_ref()), ("", None));
    let comments = github.review_comments(5).unwrap();
    assert_eq!((comments[0].line, comments[0].original_line), (None, Some(4)));
    let reviews_call = runner.calls.borrow()[1].clone();
    assert!(reviews_call.ends_with(&["--paginate".into(), "--slurp".into()]), "{reviews_call:?}");
    let error = github.pull_request_status(6).unwrap_err().to_string();
    assert!(error.contains("pull request number"), "{error}");
}

#[test]
fn wait_commands_parse() {
    let parse = |args: &[&str]| Cli::try_parse_from(std::iter::once("gho").chain(args.iter().copied()));
    assert!(parse(&["wait", "agents"]).is_ok());
    assert!(parse(&["wait", "agents", "7", "8/reviewer", "--all", "--since", "start", "--timeout", "60"]).is_ok());
    assert!(parse(&["wait", "review", "--pr", "5", "--since", "2026-01-01T00:00:00Z,1", "--interval", "10"]).is_ok());
    for bad in [&["wait"][..], &["wait", "agents", "--interval", "0"], &["wait", "review", "5"]] {
        assert_eq!(parse(bad).unwrap_err().exit_code(), 2, "{bad:?}");
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git").args(args).current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

/// The extension and `gho wait agents` agree on the status file: drive the real extension with Node, then
/// run the real binary in a temporary repository with an issue worktree.
#[test]
fn gho_reads_the_status_the_extension_writes() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("skipping: node is not installed");
        return;
    }
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "-q", "-b", "main"]);
    git(&source, &["remote", "add", "origin", "git@github.com:Acme/App.git"]);
    git(
        &source,
        &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"],
    );
    let worktree = root.join("gh-7");
    git(&source, &["worktree", "add", "-q", "-b", "Owner/gh-7", worktree.to_str().unwrap()]);
    let config_dir = root.join("config");
    fs::create_dir_all(config_dir.join("repos/acme")).unwrap();
    fs::write(config_dir.join("config.toml"), "owner = \"Owner\"\n").unwrap();
    fs::write(config_dir.join("repos/acme/app.toml"), format!("project_url = \"{PROJECT}\"\n")).unwrap();

    let extension = Path::new(env!("CARGO_MANIFEST_DIR")).join("extensions/agent-status.mjs");
    let script = r#"
        const { default: agentStatus } = await import(process.argv[1]);
        const handlers = new Map();
        const pi = {
            registerFlag() {}, getFlag: () => "implementer", on: (name, handler) => handlers.set(name, handler),
        };
        agentStatus(pi);
        const entries = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }];
        const ctx = {
            cwd: process.argv[2], isIdle: () => false, ui: { notify() {} },
            sessionManager: { getSessionFile: () => "/s.jsonl", getBranch: () => entries },
        };
        for (const name of ["session_start", "agent_start", "agent_settled"]) {
            await handlers.get(name)({ type: name, reason: "startup" }, ctx);
        }
        process.exit(0);
    "#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script, extension.to_str().unwrap(), worktree.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));

    let output = Command::new(env!("CARGO_BIN_EXE_gho"))
        .args(["--config-dir", config_dir.to_str().unwrap(), "wait", "agents", "7", "--timeout", "10"])
        .current_dir(&source)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["result"], "settled");
    assert_eq!(value["agents"][0]["id"], "7/implementer");
    assert_eq!(value["agents"][0]["last_message"], "Done.");
    assert_eq!(value["agents"][0]["worktree"], worktree.to_str().unwrap());
    let cursor = value["cursor"].as_str().unwrap();

    // From that cursor nothing new happens, so a short wait times out and keeps the cursor.
    let output = Command::new(env!("CARGO_BIN_EXE_gho"))
        .args(["--config-dir", config_dir.to_str().unwrap(), "wait", "agents", "--since", cursor])
        .args(["--timeout", "1", "--interval", "1"])
        .current_dir(&worktree)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!((value["result"].as_str(), value["cursor"].as_str()), (Some("timeout"), Some(cursor)));
    assert_eq!(value["agents"][0]["new"], false);
}
