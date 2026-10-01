//! Small value types shared by adapters. No I/O and no agent instructions.

use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Result, bail, ensure};

static REPO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").unwrap());
static ISSUE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/issues/([1-9][0-9]*)$").unwrap()
});

/// Check that `value` is `OWNER/REPO`.
pub fn validate_repo(value: &str) -> Result<()> {
    ensure!(
        REPO.is_match(value) && value.split('/').all(|part| part != "." && part != ".."),
        "Repository must be OWNER/REPO on github.com."
    );
    Ok(())
}

/// A github.com issue. GitHub names are case-insensitive, so the repository is stored lowercase.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct IssueRef {
    repo: String,
    number: u64,
}

impl IssueRef {
    pub fn new(repo: &str, number: u64) -> Result<Self> {
        validate_repo(repo)?;
        ensure!(number >= 1, "Issue number must be a positive integer.");
        Ok(IssueRef { repo: repo.to_lowercase(), number })
    }

    /// Parse a full issue URL, or (when `repo` is given) a bare number such as `42` or `#42`.
    pub fn parse(value: &str, repo: Option<&str>) -> Result<Self> {
        if let Some(captures) = ISSUE_URL.captures(value.trim_end_matches('/'))
            && let Ok(number) = captures[2].parse()
        {
            return IssueRef::new(&captures[1], number);
        }
        let digits = value.strip_prefix('#').unwrap_or(value);
        if let Some(repo) = repo
            && digits.bytes().all(|b| b.is_ascii_digit())
            && let Ok(number) = digits.parse()
        {
            return IssueRef::new(repo, number);
        }
        bail!("Use an issue number or a full https://github.com/OWNER/REPO/issues/N URL.")
    }

    /// `owner/repo`, lowercase.
    pub fn repo(&self) -> &str {
        &self.repo
    }

    pub fn number(&self) -> u64 {
        self.number
    }

    pub fn url(&self) -> String {
        format!("https://github.com/{}/issues/{}", self.repo, self.number)
    }
}

impl fmt::Display for IssueRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}#{}", self.repo, self.number)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StateReason {
    Completed,
    NotPlanned,
    Reopened,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub repo: String,
    pub state: PullRequestState,
    pub draft: bool,
    pub base: String,
    pub head: String,
    /// Present exactly when the pull request is merged.
    pub merge_commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub reference: IssueRef,
    pub title: String,
    pub body: String,
    pub state: IssueState,
    pub state_reason: Option<StateReason>,
    pub assignees: Vec<String>,
    pub project_ids: Vec<String>,
    pub blockers: Vec<IssueRef>,
    pub pull_requests: Vec<PullRequest>,
}

impl Issue {
    /// Not-planned and duplicate closures do not mean successful delivery.
    pub fn completed(&self) -> bool {
        self.state == IssueState::Closed && self.state_reason == Some(StateReason::Completed)
    }
}

/// SHA-256 of the compact JSON encoding, matching `JSON.stringify` in the Obsidian plugin.
pub fn digest(urls: &[String]) -> String {
    let json = serde_json::to_string(urls).expect("strings serialize");
    Sha256::digest(json.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}
