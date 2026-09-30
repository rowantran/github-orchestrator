//! Git and Worktrunk operations on the configured checkout.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::config::Config;
use crate::process::{Cmd, Runner};
use crate::{Error, Result, bail, ensure};

static REMOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$").unwrap()
});

/// `owner/repo` (lowercase) for a github.com remote URL without credentials; otherwise `None`.
pub fn github_remote_repo(url: &str) -> Option<String> {
    REMOTE.captures(url).map(|captures| captures[1].to_lowercase())
}

/// The result of `gho worktree`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Created {
    pub issue: u64,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
    pub path: String,
}

pub struct Workspace<'a> {
    pub config: &'a Config,
    runner: &'a dyn Runner,
}

impl<'a> Workspace<'a> {
    pub fn new(config: &'a Config, runner: &'a dyn Runner) -> Self {
        Workspace { config, runner }
    }

    fn git(&self, args: &[&str], timeout: u64) -> Result<String> {
        let argv = std::iter::once("git").chain(args.iter().copied());
        let output = self.runner.run(&Cmd::new(argv).cwd(&self.config.checkout).timeout(timeout))?;
        Ok(output.trim().to_string())
    }

    /// Check that the checkout is a repository root whose origin is the configured repository.
    pub fn verify_checkout(&self) -> Result<()> {
        let root = Path::new(&self.git(&["rev-parse", "--show-toplevel"], 60)?).canonicalize()?;
        ensure!(root == self.config.checkout, "checkout must name the repository root.");
        let origin = self.git(&["remote", "get-url", "origin"], 60)?;
        ensure!(
            github_remote_repo(&origin).as_deref() == Some(self.config.repo.to_lowercase().as_str()),
            "The checkout's origin does not match the configured GitHub repository."
        );
        Ok(())
    }

    pub fn branch_exists(&self, branch: &str) -> Result<bool> {
        match self.git(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], 60) {
            Ok(_) => Ok(true),
            Err(error) if error.exit_code() == Some(1) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Branch name → worktree path, for every worktree of the checkout.
    pub fn worktrees(&self) -> Result<BTreeMap<String, String>> {
        let mut result = BTreeMap::new();
        let mut path = None;
        for line in self.git(&["worktree", "list", "--porcelain"], 60)?.lines() {
            if let Some(worktree) = line.strip_prefix("worktree ") {
                path = Some(worktree.to_string());
            } else if let (Some(branch), Some(path)) = (line.strip_prefix("branch refs/heads/"), &path) {
                result.insert(branch.to_string(), path.clone());
            }
        }
        Ok(result)
    }

    /// Fetch `branch` from origin; returns the remote-tracking name to start from, `origin/<branch>`.
    pub fn fetch(&self, branch: &str) -> Result<String> {
        self.git(&["fetch", "origin", branch], 300)?;
        Ok(format!("origin/{branch}"))
    }

    /// Create the issue's branch and worktree from the latest base branch, or on top of `base` to stack.
    pub fn create(&self, number: u64, base: Option<&str>) -> Result<Created> {
        let branch = self.config.branch(number);
        let existing = self.worktrees()?.remove(&branch);
        if let Some(path) = existing {
            bail!("Branch {branch} already exists at {path}. Continue there, or remove it first.");
        }
        if self.branch_exists(&branch)? {
            bail!("Branch {branch} already exists (no worktree). Continue there, or remove it first.");
        }
        let base = match base {
            Some(base) => base.to_string(),
            None => self.fetch(&self.config.base_branch)?,
        };
        let commit = self
            .git(&["rev-parse", "--verify", &format!("{base}^{{commit}}")], 60)
            .map_err(|_| Error::msg(format!("Unknown base {base:?}; use a branch, tag or commit.")))?;
        let checkout = self.config.checkout.to_string_lossy();
        let wt =
            ["wt", "-C", &checkout, "switch", "--create", &branch, "--base", &commit, "--no-cd", "--format", "json"];
        self.runner.run(&Cmd::new(wt).cwd(&self.config.checkout).timeout(600))?;
        let Some(path) = self.worktrees()?.remove(&branch) else {
            bail!("Worktrunk did not report a worktree for {branch}.");
        };
        Ok(Created { issue: number, branch, base, base_commit: commit, path })
    }
}
