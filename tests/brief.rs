//! The task brief: rendering from agent-context/brief.md and writing it into a worktree, in temporary directories.

use std::fs;
use std::path::Path;
use std::process::Command;

use github_orchestrator::brief::{self, Facts};
use tempfile::TempDir;

fn facts(title: &str) -> Facts<'_> {
    Facts {
        number: 42,
        title,
        url: "https://github.com/acme/app/issues/42",
        repo: "Acme/App",
        branch: "Owner/gh-42",
        base_branch: "Owner/gh-41",
    }
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git").arg("-C").arg(path).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn render_fills_every_placeholder_and_drops_the_maintainer_comment() {
    let text = brief::render(&facts("Add the {{branch}} widget"));
    assert!(text.starts_with("# Issue #42: Add the {{branch}} widget\n"), "{text}");
    for value in ["https://github.com/acme/app/issues/42", "`Owner/gh-42`", "`Owner/gh-41`", "--repo Acme/App"] {
        assert!(text.contains(value), "{value}: {text}");
    }
    assert!(!text.contains("<!--"), "{text}");
    assert_eq!(text.matches("{{").count(), 1, "only the title's braces remain: {text}");
}

#[test]
fn write_puts_the_brief_in_an_ignored_directory() {
    let dir = TempDir::new().unwrap();
    git(dir.path(), &["init", "-q"]);
    let path = brief::write(dir.path(), "the brief\n").unwrap();
    assert_eq!(path, dir.path().join(".gho/brief.md"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "the brief\n");
    assert_eq!(git(dir.path(), &["status", "--porcelain", "--untracked-files=all"]), "");
}

#[test]
fn write_refuses_an_existing_gho_directory() {
    let dir = TempDir::new().unwrap();
    fs::create_dir(dir.path().join(".gho")).unwrap();
    let error = brief::write(dir.path(), "the brief\n").unwrap_err().to_string();
    assert!(error.contains(".gho already exists"), "{error}");
    assert!(!dir.path().join(".gho/brief.md").exists());
}
