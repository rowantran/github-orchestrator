use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::Parser;
use github_orchestrator::cli::{self, Cli};
use github_orchestrator::config::Config;
use github_orchestrator::domain::{Issue, IssueRef, IssueState, PullRequest, PullRequestState, StateReason};
use github_orchestrator::notes::Notes;
use github_orchestrator::process::{Cmd, Runner, System};
use github_orchestrator::work::{Blocker, Entry, Issues, LinkedPullRequest, State};
use github_orchestrator::{Error, Result};
use serde_json::json;
use tempfile::TempDir;

const PROJECT: &str = "https://github.com/users/Owner/projects/1";

/// Runs git for real (in temporary repositories) and answers the one gh command `gho init` runs.
#[derive(Default)]
struct InitRunner {
    gh_calls: Cell<usize>,
}

impl Runner for InitRunner {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        match cmd.argv[0].as_str() {
            "git" => System.run(cmd),
            "gh" => {
                assert_eq!(cmd.argv[1..], ["api", "--hostname", "github.com", "user", "--jq", ".login"]);
                self.gh_calls.set(self.gh_calls.get() + 1);
                Ok("Owner\n".into())
            }
            _ => panic!("Unexpected command: {:?}", cmd.argv),
        }
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git").args(args).current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

/// A local repository whose origin is github.com/Acme/App, without any network access.
fn clone_of(root: &Path, name: &str, origin: &str) -> PathBuf {
    let path = root.join(name);
    fs::create_dir(&path).unwrap();
    git(&path, &["init", "-q"]);
    git(&path, &["remote", "add", "origin", origin]);
    path
}

struct Initialized {
    dir: TempDir,
    config_dir: PathBuf,
    runner: InitRunner,
}

impl Initialized {
    fn root(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    fn source(&self) -> PathBuf {
        self.root().join("source")
    }

    fn global(&self) -> PathBuf {
        self.config_dir.join("config.toml")
    }

    fn repo(&self) -> PathBuf {
        self.config_dir.join("repos/acme/app.toml")
    }

    fn init(&self, cwd: &Path) -> String {
        let mut out = Vec::new();
        cli::init(&self.config_dir, cwd, &self.runner, &mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    fn load(&self) -> Result<Config> {
        cli::load(&self.config_dir, &self.source(), &self.runner)
    }

    fn edit(&self, path: &Path, old: &str, new: &str) {
        let text = fs::read_to_string(path).unwrap();
        assert!(text.contains(old), "{text}");
        fs::write(path, text.replacen(old, new, 1)).unwrap();
    }
}

/// `gho init` in a fresh clone, then fill in the configs the way a user would.
fn initialized() -> Initialized {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let source = clone_of(&root, "source", "git@github.com:Acme/App.git");
    git(&source, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    let state = Initialized { config_dir: root.join("config"), dir, runner: InitRunner::default() };
    let out = state.init(&source);
    assert!(out.contains("Next: set project_url in"), "{out}");
    state.edit(&state.repo(), "project_url = \"\"", &format!("project_url = \"{PROJECT}\""));
    let vault = format!("[obsidian]\nvault = \"{}\"", root.join("vault").display());
    state.edit(&state.global(), "# [obsidian]\n# vault = \"~/Obsidian/Vault\"", &vault);
    state.edit(&state.global(), "# implementer_model", "implementer_model");
    state
}

#[test]
fn init_creates_missing_configs_with_inferred_values_and_never_overwrites() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let source = clone_of(&root, "source", "https://github.com/Acme/App.git");
    fs::create_dir(source.join("sub")).unwrap();
    let state = Initialized { config_dir: root.join("config"), dir, runner: InitRunner::default() };

    // Outside a checkout, only the global config.
    let out = state.init(&root);
    assert!(out.contains("Created") && out.contains("(owner Owner)") && out.contains("Not in a git checkout"), "{out}");
    assert!(fs::read_to_string(state.global()).unwrap().contains("\nowner = \"Owner\"\n"));
    assert!(!state.config_dir.join("repos").exists());

    // In a checkout (here a subdirectory), the repository config; origin/HEAD is unknown, so main.
    let out = state.init(&source.join("sub"));
    assert!(out.contains(&format!("Exists, unchanged: {}", state.global().display())), "{out}");
    assert!(out.contains("(acme/app, base branch main)"), "{out}");
    let repo = fs::read_to_string(state.repo()).unwrap();
    assert!(repo.starts_with("# gho settings for acme/app.") && repo.contains("\nbase_branch = \"main\"\n"));
    let error = state.load().unwrap_err().to_string();
    assert!(error.ends_with("app.toml: fill in project_url."), "{error}");

    // Edits survive; nothing is asked again.
    state.edit(&state.repo(), "base_branch = \"main\"", "base_branch = \"develop\"");
    let before = (fs::read(state.global()).unwrap(), fs::read(state.repo()).unwrap());
    let out = state.init(&source);
    assert_eq!(out.matches("Exists, unchanged").count(), 2, "{out}");
    assert!(out.ends_with("Next: gho doctor\n"), "{out}");
    assert_eq!((fs::read(state.global()).unwrap(), fs::read(state.repo()).unwrap()), before);
    assert_eq!(state.runner.gh_calls.get(), 1);
}

#[test]
fn init_refuses_a_checkout_without_a_github_origin_before_writing() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let source = clone_of(&root, "source", "https://gitlab.com/acme/app.git");
    let error = cli::init(&root.join("config"), &source, &InitRunner::default(), &mut Vec::new()).unwrap_err();
    assert!(error.to_string().contains("is not a github.com repository"), "{error}");
    assert!(!root.join("config").exists());
}

#[test]
fn filled_in_configs_load() {
    let state = initialized();
    let config = state.load().unwrap();
    assert_eq!((config.repo.as_str(), config.owner.as_str()), ("acme/app", "Owner"));
    assert_eq!(config.project_url, PROJECT);
    assert_eq!(config.checkout, state.source());
    assert_eq!(config.base_branch, "trunk");
    assert_eq!(config.vault, Some(state.root().join("vault")));
    assert!(!state.root().join("vault").exists());
    assert_eq!(config.branch(42), "Owner/gh-42");
    assert_eq!(config.agents.implementer_model.as_deref(), Some("anthropic/claude-opus-4-5:high"));
    assert_eq!(config.agents.reviewer_model, None);
}

fn run_binary(cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_gho")).args(args).current_dir(cwd).env_remove("GHO_CONFIG_DIR").output().unwrap()
}

#[test]
fn invalid_config_has_actionable_error() {
    let cases = [
        (true, "owner = \"Owner\"", "owner = \"Owner\"\n[queue"),
        (true, "owner = \"Owner\"", "owner = \"no spaces\""),
        (true, "implementer_model = \"anthropic/claude-opus-4-5:high\"", "implementer_model = \"opus; rm -rf /\""),
        (true, "implementer_model = \"anthropic/claude-opus-4-5:high\"", "implementer-model = \"opus\""),
        (true, "owner = \"Owner\"", "owner = \"Owner\"\nbase_branch = \"main\""),
        (false, PROJECT, "https://github.com/acme/app"),
        (false, "base_branch = \"trunk\"", "base_branch = \"../x\""),
        (false, "base_branch = \"trunk\"", "base_branch = \"trunk\"\nbase-branch = \"typo\""),
        (false, "base_branch = \"trunk\"", "base_branch = \"trunk\"\nowner = \"Owner\""),
    ];
    for (global, old, new) in cases {
        let state = initialized();
        let path = if global { state.global() } else { state.repo() };
        state.edit(&path, old, new);
        assert!(state.load().is_err(), "{new}");
        let output = run_binary(&state.source(), &["--config-dir", state.config_dir.to_str().unwrap(), "ready"]);
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(output.status.code(), Some(1), "{stderr}");
        let prefix = format!("gho: Invalid config {}", path.display());
        assert!(stderr.starts_with(&prefix) && !stderr.contains("panicked"), "{stderr}");
    }
}

#[test]
fn config_prints_agent_models_without_touching_github() {
    let state = initialized();
    state.edit(&state.global(), "# reviewer_model", "reviewer_model");
    let output = run_binary(&state.source(), &["--config-dir", state.config_dir.to_str().unwrap(), "config"]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["repo"], "acme/app");
    assert_eq!(value["checkout"], state.source().to_str().unwrap());
    assert_eq!(
        value["agents"],
        json!({"implementer_model": "anthropic/claude-opus-4-5:high", "reviewer_model": "openai/gpt-5"})
    );
}

#[test]
fn missing_config_points_to_init() {
    let state = initialized();
    let config_dir = state.config_dir.to_str().unwrap();
    let other = clone_of(&state.root(), "other", "git@github.com:acme/other.git");
    let empty = state.root().join("empty");
    fs::create_dir(&empty).unwrap();
    for (cwd, args, message) in [
        (&state.source(), ["--config-dir", "none", "ready"], "config.toml. Run gho init."),
        (&other, ["--config-dir", config_dir, "ready"], "other.toml. Run gho init in a checkout of acme/other."),
        (&empty, ["--config-dir", config_dir, "ready"], "Run gho inside a checkout of a GitHub repository."),
    ] {
        let output = run_binary(cwd, &args);
        assert_eq!(output.status.code(), Some(1));
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains(message), "{stderr}");
    }
}

#[test]
fn parser_rejects_incomplete_or_removed_commands() {
    for argv in [
        &["worktree"][..],
        &["init", "--project", "https://github.com/users/Owner/projects/1"],
        &["--config", "gho.toml", "init"],
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
            draft: false,
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
    let config = state.load().unwrap();
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
    let config = state.load().unwrap();
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
    let output = run_binary(Path::new("."), &["--help"]);
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    for command in ["init", "doctor", "config", "ready", "worktree", "task", "notes"] {
        assert!(help.contains(command), "{help}");
    }
    let _ = Cli::parse_from(["gho", "ready", "--all", "--json"]);
}
