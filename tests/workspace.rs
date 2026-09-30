//! Real Git/Worktrunk tests in disposable repositories, never a developer checkout.

use std::fs;
use std::path::Path;
use std::process::Command;

use github_orchestrator::config::Config;
use github_orchestrator::process::{System, which};
use github_orchestrator::workspace::{Workspace, github_remote_repo};
use tempfile::TempDir;

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git").arg("-C").arg(path).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn commit(path: &Path, name: &str, message: &str) -> String {
    fs::write(path.join(name), format!("{message}\n")).unwrap();
    git(path, &["add", name]);
    git(
        path,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "-m",
            message,
        ],
    );
    git(path, &["rev-parse", "HEAD"])
}

/// A checkout whose origin is a local bare repository standing in for GitHub.
struct Repository {
    _dir: TempDir,
    config: Config,
    seed: std::path::PathBuf,
}

fn repository() -> Repository {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (origin, seed, checkout) = (root.join("origin.git"), root.join("seed"), root.join("checkout"));
    git(&root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(&root, &["clone", "-q", origin.to_str().unwrap(), seed.to_str().unwrap()]);
    commit(&seed, "README.md", "initial");
    git(&seed, &["push", "-q", "origin", "HEAD:main"]);
    git(&root, &["clone", "-q", origin.to_str().unwrap(), checkout.to_str().unwrap()]);
    let config = Config {
        repo: "example/mono".into(),
        owner: "rowantran".into(),
        project_id: "PVT_example".into(),
        project_url: "https://github.com/users/rowantran/projects/1".into(),
        checkout,
        base_branch: "main".into(),
        vault: None,
    };
    Repository { _dir: dir, config, seed }
}

/// Worktrunk integration runs only where `wt` is installed.
fn has_wt() -> bool {
    let found = which("wt").is_some();
    if !found {
        eprintln!("skipped: Worktrunk integration requires wt");
    }
    found
}

#[test]
fn remote_canonicalization() {
    for url in
        ["https://github.com/example/mono.git", "https://github.com/example/mono", "git@github.com:example/mono.git"]
    {
        assert_eq!(github_remote_repo(url).as_deref(), Some("example/mono"), "{url}");
    }
}

#[test]
fn remote_rejects_credentials_and_other_hosts() {
    for url in [
        "https://token@github.com/example/mono.git",
        "https://github.com.evil/owner/repo",
        "/tmp/repo",
        "ssh://evil/path",
    ] {
        assert_eq!(github_remote_repo(url), None, "{url}");
    }
}

#[test]
fn verify_checkout_requires_matching_github_origin() {
    let repo = repository();
    let workspace = Workspace::new(&repo.config, &System);
    let error = workspace.verify_checkout().unwrap_err();
    assert!(error.to_string().contains("origin"), "{error}");
    git(&repo.config.checkout, &["remote", "set-url", "origin", "git@github.com:Example/Mono.git"]);
    workspace.verify_checkout().unwrap();
}

#[test]
fn worktree_starts_from_latest_fetched_base() {
    if !has_wt() {
        return;
    }
    let repo = repository();
    let latest = commit(&repo.seed, "new.txt", "landed on main after the clone");
    git(&repo.seed, &["push", "-q", "origin", "HEAD:main"]);
    let workspace = Workspace::new(&repo.config, &System);
    let created = workspace.create(42, None).unwrap();
    assert_eq!(created.branch, "rowantran/gh-42");
    assert_eq!((created.base.as_str(), created.base_commit.as_str()), ("origin/main", latest.as_str()));
    let path = Path::new(&created.path);
    assert_eq!(git(path, &["rev-parse", "HEAD"]), latest);
    assert_eq!(git(path, &["branch", "--show-current"]), "rowantran/gh-42");
    assert_eq!(workspace.worktrees().unwrap()["rowantran/gh-42"], created.path);
    assert_eq!(git(&repo.config.checkout, &["status", "--porcelain"]), "");
}

#[test]
fn worktree_can_stack_on_unmerged_branch() {
    if !has_wt() {
        return;
    }
    let repo = repository();
    let workspace = Workspace::new(&repo.config, &System);
    let upstream = workspace.create(1, None).unwrap();
    let upstream_commit = commit(Path::new(&upstream.path), "feature.txt", "unmerged upstream work");
    let stacked = workspace.create(2, Some("rowantran/gh-1")).unwrap();
    assert_eq!((stacked.base.as_str(), stacked.base_commit.as_str()), ("rowantran/gh-1", upstream_commit.as_str()));
    assert_eq!(fs::read_to_string(Path::new(&stacked.path).join("feature.txt")).unwrap(), "unmerged upstream work\n");
}

#[test]
fn fetch_returns_the_latest_pushed_branch_to_stack_on() {
    // Stacking on a blocker that is ready for review starts from its pushed branch, even with no local copy.
    let repo = repository();
    git(&repo.seed, &["switch", "-q", "-c", "rowantran/gh-1"]);
    let pushed = commit(&repo.seed, "feature.txt", "blocker work under review");
    git(&repo.seed, &["push", "-q", "origin", "rowantran/gh-1"]);
    let workspace = Workspace::new(&repo.config, &System);
    assert_eq!(workspace.fetch("rowantran/gh-1").unwrap(), "origin/rowantran/gh-1");
    assert_eq!(git(&repo.config.checkout, &["rev-parse", "origin/rowantran/gh-1"]), pushed);
    assert!(!workspace.branch_exists("rowantran/gh-1").unwrap());
    if has_wt() {
        let stacked = workspace.create(2, Some("origin/rowantran/gh-1")).unwrap();
        assert_eq!(stacked.base_commit, pushed);
    }
}

#[test]
fn existing_branch_is_reported_not_replaced() {
    if !has_wt() {
        return;
    }
    let repo = repository();
    let workspace = Workspace::new(&repo.config, &System);
    let first = workspace.create(7, None).unwrap();
    let error = workspace.create(7, None).unwrap_err().to_string();
    assert!(error.contains(&format!("already exists at {}", first.path)), "{error}");
    git(&repo.config.checkout, &["branch", "rowantran/gh-8"]);
    let error = workspace.create(8, None).unwrap_err().to_string();
    assert!(error.contains("no worktree"), "{error}");
}

#[test]
fn branch_exists_distinguishes_missing_from_failure() {
    let repo = repository();
    let workspace = Workspace::new(&repo.config, &System);
    assert!(workspace.branch_exists("main").unwrap());
    assert!(!workspace.branch_exists("rowantran/gh-99").unwrap());
}

#[test]
fn unknown_base_is_an_actionable_error() {
    let repo = repository();
    let error = Workspace::new(&repo.config, &System).create(3, Some("nope")).unwrap_err().to_string();
    assert!(error.contains("Unknown base \"nope\""), "{error}");
}
