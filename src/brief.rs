//! The task brief: a file in each new worktree that tells implementer and reviewer agents which issue,
//! branch and base branch they work on. The orchestrator passes it to them as their first message.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::{Result, ensure};

/// The template. Its first line is a comment for maintainers and is not part of the brief.
const TEMPLATE: &str = include_str!("../agent-context/brief.md");

/// The directory in each worktree for `gho`'s files. It holds a `.gitignore` that ignores the directory itself.
pub const DIR: &str = ".gho";

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{([a-z_]+)\}\}").unwrap());

/// The values of the template's placeholders.
pub struct Facts<'a> {
    pub number: u64,
    pub title: &'a str,
    pub url: &'a str,
    pub repo: &'a str,
    pub branch: &'a str,
    pub base_branch: &'a str,
}

/// The brief for these facts. Values are inserted in one pass, so a title with `{{…}}` stays as written.
pub fn render(facts: &Facts) -> String {
    let body = match TEMPLATE.split_once('\n') {
        Some((first, rest)) if first.starts_with("<!--") => rest,
        _ => TEMPLATE,
    };
    let number = facts.number.to_string();
    PLACEHOLDER
        .replace_all(body, |captures: &Captures| match &captures[1] {
            "number" => number.as_str(),
            "title" => facts.title,
            "url" => facts.url,
            "repo" => facts.repo,
            "branch" => facts.branch,
            "base_branch" => facts.base_branch,
            name => panic!("agent-context/brief.md uses an unknown placeholder {{{{{name}}}}}"),
        })
        .into_owned()
}

/// Write `text` to `.gho/brief.md` in a new worktree; returns the file's path.
/// Refuses a worktree that already has `.gho`, so files the repository tracks are never replaced.
pub fn write(worktree: &Path, text: &str) -> Result<PathBuf> {
    let dir = worktree.join(DIR);
    ensure!(!dir.exists(), "{} already exists; gho needs it for the task brief.", dir.display());
    fs::create_dir(&dir)?;
    fs::write(dir.join(".gitignore"), "*\n")?;
    let path = dir.join("brief.md");
    fs::write(&path, text)?;
    Ok(path)
}
