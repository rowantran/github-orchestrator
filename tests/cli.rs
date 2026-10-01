use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Parser;
use github_orchestrator::cli::{self, Cli};
use github_orchestrator::config::{Config, TEMPLATE};
use github_orchestrator::domain::{Issue, IssueRef, IssueState, PullRequest, PullRequestState, StateReason};
use github_orchestrator::notes::Notes;
use github_orchestrator::work::{Blocker, Entry, Issues, LinkedPullRequest, State};
use github_orchestrator::{Error, Result};
use serde_json::json;
use tempfile::TempDir;

const PROJECT: &str = "https://github.com/users/Owner/projects/1";

struct Initialized {
    dir: TempDir,
    config: PathBuf,
}

impl Initialized {
    fn root(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }
}

/// `gho init`, then fill in the template the way a user would.
fn initialized() -> Initialized {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    fs::create_dir(root.join("source")).unwrap();
    let state = Initialized { config: root.join("config/gho.toml"), dir };
    let mut out = Vec::new();
    cli::init(&state.config, &mut out).unwrap();
    assert!(String::from_utf8(out).unwrap().contains("then run gho doctor"));
    let source = root.join("source");
    let filled = fs::read_to_string(&state.config)
        .unwrap()
        .replace("repo = \"\"", "repo = \"acme/app\"")
        .replace("owner = \"\"", "owner = \"Owner\"")
        .replace("project_url = \"\"", &format!("project_url = \"{PROJECT}\""))
        .replace("checkout = \"\"", &format!("checkout = \"{}\"", source.display()))
        .replace(
            "# [obsidian]\n# vault = \"~/Obsidian/Vault\"",
            &format!("[obsidian]\nvault = \"{}\"", root.join("vault").display()),
        )
        .replace("# implementer_model", "implementer_model");
    fs::write(&state.config, filled).unwrap();
    state
}

#[test]
fn init_writes_the_template_and_never_overwrites() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nested/gho.toml");
    let output = run_binary(&["--config", path.to_str().unwrap(), "init"]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(fs::read_to_string(&path).unwrap(), TEMPLATE);
    let error = Config::load(&path).unwrap_err().to_string();
    assert!(error.ends_with("fill in queue.repo, queue.owner, queue.project_url, queue.checkout."), "{error}");
    fs::write(&path, "edited").unwrap();
    let error = cli::init(&path, &mut Vec::new()).unwrap_err();
    assert!(error.to_string().contains("already exists"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
}

#[test]
fn filled_in_template_loads() {
    let state = initialized();
    let config = Config::load(&state.config).unwrap();
    assert_eq!((config.repo.as_str(), config.owner.as_str()), ("acme/app", "Owner"));
    assert_eq!(config.project_url, PROJECT);
    assert_eq!(config.checkout, state.root().join("source"));
    assert_eq!(config.base_branch, "main");
    assert_eq!(config.vault, Some(state.root().join("vault")));
    assert!(!state.root().join("vault").exists());
    assert_eq!(config.branch(42), "Owner/gh-42");
    assert_eq!(config.agents.implementer_model.as_deref(), Some("anthropic/claude-opus-4-5:high"));
    assert_eq!(config.agents.reviewer_model, None);
}

fn run_binary(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_gho")).args(args).env_remove("GHO_CONFIG").output().unwrap()
}

#[test]
fn invalid_config_has_actionable_error() {
    let cases = [
        ("[queue]", "[queue"),
        (PROJECT, "https://github.com/acme/app"),
        ("repo = \"acme/app\"", "repo = \"acme/app\"\nproject_id = \"PVT_queue\""),
        ("base_branch = \"main\"", "base_branch = \"../x\""),
        ("base_branch = \"main\"", "base_branch = \"main\"\nbase-branch = \"typo\""),
        ("implementer_model = \"anthropic/claude-opus-4-5:high\"", "implementer_model = \"opus; rm -rf /\""),
        ("implementer_model = \"anthropic/claude-opus-4-5:high\"", "implementer-model = \"opus\""),
    ];
    for (old, new) in cases {
        let state = initialized();
        let original = fs::read_to_string(&state.config).unwrap();
        assert!(original.contains(old), "{original}");
        fs::write(&state.config, original.replace(old, new)).unwrap();
        assert!(Config::load(&state.config).is_err(), "{new}");
        let output = run_binary(&["--config", state.config.to_str().unwrap(), "ready"]);
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(output.status.code(), Some(1), "{stderr}");
        assert!(stderr.starts_with("gho: Invalid config") && !stderr.contains("panicked"), "{stderr}");
    }
}

#[test]
fn config_prints_agent_models_without_touching_github() {
    let state = initialized();
    let original = fs::read_to_string(&state.config).unwrap();
    fs::write(&state.config, format!("{original}reviewer_model = \"openai/gpt-5\"\n")).unwrap();
    let output = run_binary(&["--config", state.config.to_str().unwrap(), "config"]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["repo"], "acme/app");
    assert_eq!(
        value["agents"],
        json!({"implementer_model": "anthropic/claude-opus-4-5:high", "reviewer_model": "openai/gpt-5"})
    );
}

#[test]
fn missing_config_points_to_init() {
    let dir = TempDir::new().unwrap();
    let output = run_binary(&["--config", dir.path().join("none.toml").to_str().unwrap(), "ready"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8(output.stderr).unwrap().contains("Create it with gho init."));
}

#[test]
fn parser_rejects_incomplete_or_removed_commands() {
    for argv in [
        &["worktree"][..],
        &["init", "--project", "https://github.com/users/Owner/projects/1"],
        &["notes", "link", "task.md"],
        &["approve", "1"],
        &["task", "create", "--title", "x"],
    ] {
        let error = Cli::try_parse_from(std::iter::once("gho").chain(argv.iter().copied())).unwrap_err();
        assert_eq!(error.exit_code(), 2, "{argv:?}");
    }
    let cli = Cli::try_parse_from([
        "gho",
        "task",
        "create",
        "--title",
        "T",
        "--body-file",
        "b.md",
        "--blocked-by",
        "1,2",
        "--blocked-by",
        "3",
    ]);
    assert!(cli.is_ok());
}

fn entry(number: u64, title: &str, state: State, worktree: Option<&str>, blockers: Vec<Blocker>) -> Entry {
    Entry {
        number,
        title: title.into(),
        url: format!("https://github.com/acme/app/issues/{number}"),
        state,
        branch: format!("Owner/gh-{number}"),
        worktree: worktree.map(Into::into),
        blockers,
        body: String::new(),
    }
}

fn in_review(number: u64) -> State {
    State::ReadyForReview {
        pull_request: LinkedPullRequest {
            url: format!("https://github.com/acme/app/pull/{number}0"),
            state: PullRequestState::Open,
            head: format!("Owner/gh-{number}"),
            base: "main".into(),
        },
    }
}

fn blocker(number: u64, state: State, branch: Option<&str>) -> Blocker {
    Blocker {
        number,
        repo: "acme/app".into(),
        url: format!("https://github.com/acme/app/issues/{number}"),
        title: format!("Issue {number}"),
        state,
        branch: branch.map(Into::into),
        worktree: None,
        pull_requests: vec![],
    }
}

fn items() -> Vec<Entry> {
    vec![
        entry(1, "Ready one", State::Ready { stack_on: vec![] }, None, vec![]),
        entry(
            2,
            "Blocked one",
            State::Blocked,
            None,
            vec![
                blocker(1, State::InProgress, Some("Owner/gh-1")),
                blocker(6, State::Closed { reason: Some(StateReason::Duplicate) }, None),
                blocker(7, State::Done, None),
            ],
        ),
        entry(3, "Working", State::InProgress, Some("/w/3"), vec![]),
        entry(4, "In review", in_review(4), None, vec![]),
        entry(5, "Stacked", State::Ready { stack_on: vec![4] }, None, vec![blocker(4, in_review(4), None)]),
    ]
}

#[test]
fn ready_lists_ready_work_including_stacks_unless_all() {
    let mut out = Vec::new();
    cli::display_ready(&items(), false, true, &mut out).unwrap();
    let listed: serde_json::Value = serde_json::from_slice(&out).unwrap();
    let numbers: Vec<u64> = listed.as_array().unwrap().iter().map(|i| i["number"].as_u64().unwrap()).collect();
    assert_eq!(numbers, [1, 5]);
    assert_eq!(listed[1]["stack_on"], json!([4]));

    let mut out = Vec::new();
    cli::display_ready(&items(), true, false, &mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    for label in ["READY ", "BLOCKED", "IN_PROGRESS", "READY_FOR_REVIEW"] {
        assert!(out.contains(label), "{label}: {out}");
    }
    assert!(out.contains("waits on acme/app#1 (in progress on Owner/gh-1)") && out.contains("/w/3"), "{out}");
    assert!(out.contains("waits on acme/app#6 (closed as duplicate)") && !out.contains("#7"), "{out}");
    assert!(out.contains("review https://github.com/acme/app/pull/40"), "{out}");
    assert!(out.contains("stacks on #4"), "{out}");
    assert!(out.contains("waits on acme/app#4 (ready for review: https://github.com/acme/app/pull/40)"), "{out}");

    let mut out = Vec::new();
    cli::display_ready(&[], false, false, &mut out).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "Nothing ready.\n");
}

#[test]
fn worktree_without_base_starts_only_ready_issues() {
    let state = initialized();
    let config = Config::load(&state.config).unwrap();
    let items = items();
    assert_eq!(cli::stack_branch(&config, &items[0]).unwrap(), None);
    // Top of the stack; `gho worktree` fetches it and starts from origin/<branch>.
    let top = entry(8, "Two deep", State::Ready { stack_on: vec![4, 5] }, None, vec![]);
    assert_eq!(cli::stack_branch(&config, &top).unwrap().as_deref(), Some("Owner/gh-5"));

    let refused = |entry: &Entry| cli::stack_branch(&config, entry).unwrap_err().to_string();
    let blocked = refused(&items[1]);
    assert!(
        blocked.starts_with(
            "Issue #2 is blocked: it waits on acme/app#1 (in progress on Owner/gh-1), acme/app#6 (closed as duplicate)."
        ),
        "{blocked}"
    );
    assert!(blocked.ends_with("Use --base to start it anyway."), "{blocked}");
    assert!(refused(&items[2]).contains("already in progress in /w/3"));
    assert!(refused(&items[3]).contains("already has an open pull request: https://github.com/acme/app/pull/40"));
    assert!(refused(&entry(9, "Done", State::Done, None, vec![])).contains("already done"));
    let closed = entry(9, "Closed", State::Closed { reason: Some(StateReason::NotPlanned) }, None, vec![]);
    assert!(refused(&closed).contains("closed without being completed"));
}

#[test]
fn worktree_accepts_only_configured_repository() {
    let state = initialized();
    let config = Config::load(&state.config).unwrap();
    assert_eq!(cli::worktree_number(&config, "https://github.com/ACME/app/issues/5").unwrap(), 5);
    assert_eq!(cli::worktree_number(&config, "#6").unwrap(), 6);
    assert!(cli::worktree_number(&config, "https://github.com/other/repo/issues/5").is_err());
    assert!(cli::worktree_number(&config, "five").is_err());
}

#[test]
fn confirmation_requires_explicit_consent() {
    for (interactive, answer, yes, allowed) in [
        (false, "yes", false, false),
        (false, "", true, true),
        (true, "NO", false, false),
        (true, " Yes \n", false, true),
    ] {
        let result = cli::confirm(yes, interactive, || Ok(answer.into()));
        assert_eq!(result.is_ok(), allowed, "{interactive} {answer:?} {yes}");
        if let Err(error) = result {
            let message = error.to_string();
            assert!(message.contains("--yes") || message.contains("Canceled"), "{message}");
        }
    }
}

/// Issues keyed by number in acme/app, closed with the given reason (or open for `None`).
struct FakeGitHub(HashMap<u64, Option<StateReason>>);

impl Issues for FakeGitHub {
    fn queue(&self) -> Result<Vec<Issue>> {
        Err(Error::msg("unused"))
    }

    fn issue(&self, reference: &IssueRef) -> Result<Issue> {
        let reason = self.0[&reference.number()];
        Ok(Issue {
            reference: reference.clone(),
            title: String::new(),
            body: String::new(),
            state: if reason.is_some() { IssueState::Closed } else { IssueState::Open },
            state_reason: reason,
            assignees: vec![],
            project_ids: vec![],
            blockers: vec![],
            pull_requests: vec![],
        })
    }

    fn open_pull_request(&self, _branch: &str) -> Result<Option<PullRequest>> {
        Err(Error::msg("unused"))
    }
}

const URL1: &str = "https://github.com/acme/app/issues/1";
const URL2: &str = "https://github.com/acme/app/issues/2";

fn note_vault() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let vault = dir.path().canonicalize().unwrap();
    fs::create_dir(vault.join("Tasks")).unwrap();
    fs::write(vault.join("Tasks/task.md"), "---\ntype: task\n---\n").unwrap();
    (dir, vault)
}

fn request_count(vault: &Path) -> usize {
    fs::read_dir(vault.join(".github-orchestrator/requests")).map_or(0, |dir| dir.count())
}

#[test]
fn complete_notes_deduplicates_and_requires_explicit_retry() {
    let statuses = [
        None,
        Some("pending"),
        Some("processing"),
        Some("local-accepted"),
        Some("already-done"),
        Some("failed"),
        Some("stale"),
    ];
    for status in statuses {
        for retry in [false, true] {
            let (_dir, vault) = note_vault();
            let notes = Notes::new(&vault).unwrap();
            let link = notes.link("Tasks/task.md", &[URL1]).unwrap();
            if let Some(status) = status {
                let request = notes.request_completion(&link).unwrap();
                if status != "pending" {
                    let receipts = vault.join(".github-orchestrator/receipts");
                    fs::create_dir_all(&receipts).unwrap();
                    let receipt = json!({"schemaVersion": 1, "requestId": request.id, "linkId": link.id,
                                         "issueFingerprint": request.issue_fingerprint, "status": status});
                    fs::write(receipts.join(format!("{}.json", request.id)), receipt.to_string()).unwrap();
                }
            }
            let before = request_count(&vault);
            let github = FakeGitHub(HashMap::from([(1, Some(StateReason::Completed))]));
            for _ in 0..2 {
                cli::complete_notes(&github, &notes, retry, &mut Vec::new()).unwrap();
            }
            let expected = status.is_none() || (retry && matches!(status, Some("failed" | "stale")));
            assert_eq!(request_count(&vault) - before, usize::from(expected), "{status:?} retry={retry}");
        }
    }
}

#[test]
fn complete_notes_requires_every_issue_completed() {
    let cases = [
        (Some(StateReason::Completed), true),
        (Some(StateReason::NotPlanned), false),
        (Some(StateReason::Duplicate), false),
        (None, false),
    ];
    for (second, allowed) in cases {
        let (_dir, vault) = note_vault();
        let notes = Notes::new(&vault).unwrap();
        notes.link("Tasks/task.md", &[URL1, URL2]).unwrap();
        let github = FakeGitHub(HashMap::from([(1, Some(StateReason::Completed)), (2, second)]));
        let mut out = Vec::new();
        cli::complete_notes(&github, &notes, false, &mut out).unwrap();
        assert_eq!(request_count(&vault) == 1, allowed, "{second:?}");
        assert_eq!(String::from_utf8(out).unwrap().contains("Waiting:"), !allowed, "{second:?}");
    }
}

#[test]
fn help_lists_commands() {
    let output = run_binary(&["--help"]);
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    for command in ["init", "doctor", "config", "ready", "worktree", "task", "notes"] {
        assert!(help.contains(command), "{help}");
    }
    let _ = Cli::parse_from(["gho", "ready", "--all", "--json"]);
}
