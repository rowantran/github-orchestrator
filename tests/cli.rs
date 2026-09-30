use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Parser;
use github_orchestrator::cli::{self, Cli, InitArgs};
use github_orchestrator::config::Config;
use github_orchestrator::domain::{Issue, IssueRef, IssueState, StateReason};
use github_orchestrator::notes::Notes;
use github_orchestrator::process::{Cmd, Runner};
use github_orchestrator::work::{Blocker, Entry, Issues, State};
use github_orchestrator::{Error, Result};
use serde_json::json;
use tempfile::TempDir;

const PROJECT: &str = "https://github.com/users/Owner/projects/1";

/// Answers the three commands `gho init` runs.
struct InitRunner {
    checkout: PathBuf,
    calls: RefCell<Vec<Vec<String>>>,
}

impl Runner for InitRunner {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        self.calls.borrow_mut().push(cmd.argv.clone());
        let argv: Vec<&str> = cmd.argv.iter().map(String::as_str).collect();
        match argv.as_slice() {
            ["git", "remote", "get-url", "origin"] => {
                assert_eq!(cmd.cwd.as_deref(), Some(self.checkout.as_path()));
                Ok("git@github.com:Acme/App.git\n".into())
            }
            ["gh", "api", "--hostname", "github.com", "user", "--jq", ".login"] => Ok("Owner\n".into()),
            ["gh", "project", "view", "1", "--owner", "Owner", "--format", "json"] => {
                Ok(json!({"id": "PVT_queue", "url": PROJECT, "title": "Queue"}).to_string())
            }
            _ => panic!("Unexpected command: {argv:?}"),
        }
    }
}

struct Initialized {
    dir: TempDir,
    config: PathBuf,
    runner: InitRunner,
}

impl Initialized {
    fn root(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    fn args(&self) -> InitArgs {
        InitArgs {
            checkout: Some(self.root().join("source")),
            repo: None,
            owner: None,
            project: PROJECT.into(),
            base: "main".into(),
            vault: Some(self.root().join("vault")),
        }
    }
}

fn initialized() -> Initialized {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    fs::create_dir(root.join("source")).unwrap();
    let runner = InitRunner { checkout: root.join("source"), calls: RefCell::new(vec![]) };
    let state = Initialized { config: root.join("config/gho.toml"), dir, runner };
    let mut out = Vec::new();
    cli::init(&state.config, state.args(), &state.runner, &mut out).unwrap();
    assert!(String::from_utf8(out).unwrap().contains("Next: gho doctor"));
    state
}

#[test]
fn init_round_trip_and_no_overwrite() {
    let state = initialized();
    let config = Config::load(&state.config).unwrap();
    assert_eq!((config.repo.as_str(), config.owner.as_str()), ("acme/app", "Owner"));
    assert_eq!(config.checkout, state.root().join("source"));
    assert_eq!(config.base_branch, "main");
    assert_eq!(config.vault, Some(state.root().join("vault")));
    assert!(!state.root().join("vault").exists());
    assert_eq!(config.branch(42), "Owner/gh-42");
    let before = fs::read(&state.config).unwrap();
    let error = cli::init(&state.config, state.args(), &state.runner, &mut Vec::new()).unwrap_err();
    assert!(error.to_string().contains("already exists"));
    assert_eq!(fs::read(&state.config).unwrap(), before);
    assert_eq!(state.runner.calls.borrow().len(), 3);
}

fn run_binary(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_gho")).args(args).env_remove("GHO_CONFIG").output().unwrap()
}

#[test]
fn invalid_config_has_actionable_error() {
    let cases = [
        ("[queue]", "[queue"),
        ("project_id = \"PVT_queue\"", "project_id = 7"),
        ("base_branch = \"main\"", "base_branch = \"../x\""),
        ("base_branch = \"main\"", "base_branch = \"main\"\nbase-branch = \"typo\""),
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
fn missing_config_points_to_init() {
    let dir = TempDir::new().unwrap();
    let output = run_binary(&["--config", dir.path().join("none.toml").to_str().unwrap(), "ready"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8(output.stderr).unwrap().contains("gho init --help"));
}

#[test]
fn init_rejects_repo_mismatch_before_creating_config() {
    let state = initialized();
    let other = state.config.with_file_name("other.toml");
    let args = InitArgs { repo: Some("other/repo".into()), ..state.args() };
    let error = cli::init(&other, args, &state.runner, &mut Vec::new()).unwrap_err();
    assert!(error.to_string().contains("origin must match"));
    assert!(!other.exists());
}

#[test]
fn parser_rejects_incomplete_or_removed_commands() {
    for argv in [
        &["worktree"][..],
        &["init"],
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

fn items() -> Vec<Entry> {
    let blocker = Blocker {
        number: 1,
        repo: "acme/app".into(),
        url: "https://github.com/acme/app/issues/1".into(),
        title: "Ready one".into(),
        done: false,
        state: IssueState::Open,
        state_reason: None,
        branch: Some("Owner/gh-1".into()),
        worktree: None,
        pull_requests: vec![],
    };
    vec![
        entry(1, "Ready one", State::Ready, None, vec![]),
        entry(2, "Blocked one", State::Blocked, None, vec![blocker]),
        entry(3, "Working", State::InProgress, Some("/w/3"), vec![]),
    ]
}

#[test]
fn ready_lists_only_ready_work_unless_all() {
    let mut out = Vec::new();
    cli::display_ready(&items(), false, true, &mut out).unwrap();
    let listed: serde_json::Value = serde_json::from_slice(&out).unwrap();
    let numbers: Vec<u64> = listed.as_array().unwrap().iter().map(|i| i["number"].as_u64().unwrap()).collect();
    assert_eq!(numbers, [1]);

    let mut out = Vec::new();
    cli::display_ready(&items(), true, false, &mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    assert!(out.contains("READY") && out.contains("BLOCKED") && out.contains("IN_PROGRESS"), "{out}");
    assert!(out.contains("waits on acme/app#1 (branch Owner/gh-1)") && out.contains("/w/3"), "{out}");

    let mut out = Vec::new();
    cli::display_ready(&[], false, false, &mut out).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "Nothing ready.\n");
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
    for command in ["init", "doctor", "ready", "worktree", "task", "notes"] {
        assert!(help.contains(command), "{help}");
    }
    let _ = Cli::parse_from(["gho", "ready", "--all", "--json"]);
}
