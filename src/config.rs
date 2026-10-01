//! One queue per config file: which GitHub issues are yours, and which checkout gets the worktrees.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::domain::validate_repo;
use crate::paths::{expand_user, resolve};
use crate::{Error, Result, ensure};

static OWNER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$").unwrap());
static PROJECT_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https://github\.com/(?:users|orgs)/[A-Za-z0-9-]+/projects/[1-9][0-9]*/?$").unwrap());
static BRANCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$").unwrap());
/// A Pi `--model` pattern such as `anthropic/claude-opus-4-5:high`: one word, no shell metacharacters.
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$").unwrap());

/// `$GHO_CONFIG`, or `~/.config/github-orchestrator/config.toml`.
pub fn default_config_path() -> PathBuf {
    let path = std::env::var_os("GHO_CONFIG").unwrap_or_else(|| "~/.config/github-orchestrator/config.toml".into());
    expand_user(Path::new(&path))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Config {
    pub repo: String,
    pub owner: String,
    pub project_id: String,
    pub project_url: String,
    /// Absolute and symlink-free.
    pub checkout: PathBuf,
    pub base_branch: String,
    /// Absolute and symlink-free.
    pub vault: Option<PathBuf>,
    pub agents: Agents,
}

/// Models the orchestrator passes to Pi's `--model` when it launches agents. gho only stores them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Agents {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub implementer_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_model: Option<String>,
}

impl Agents {
    fn is_empty(&self) -> bool {
        self.implementer_model.is_none() && self.reviewer_model.is_none()
    }
}

/// The file layout. Unknown keys are rejected so a typo cannot be silently ignored.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    queue: Queue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    obsidian: Option<Obsidian>,
    #[serde(default, skip_serializing_if = "Agents::is_empty")]
    agents: Agents,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Queue {
    repo: String,
    owner: String,
    project_id: String,
    project_url: String,
    checkout: PathBuf,
    #[serde(default = "main")]
    base_branch: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Obsidian {
    #[serde(default)]
    vault: Option<PathBuf>,
}

fn main() -> String {
    "main".into()
}

impl Config {
    /// The one branch name gho uses for an issue; also how `ready` spots work in progress.
    pub fn branch(&self, number: u64) -> String {
        format!("{}/gh-{number}", self.owner)
    }

    pub fn validate(&self) -> Result<()> {
        validate_repo(&self.repo)?;
        ensure!(OWNER.is_match(&self.owner), "owner must be a GitHub login.");
        ensure!(
            self.project_id.starts_with("PVT_"),
            "project_id must be a GitHub Projects v2 ID (PVT_…). Run gho init."
        );
        ensure!(
            PROJECT_URL.is_match(&self.project_url),
            "project_url must be a github.com user or organization Project URL."
        );
        ensure!(BRANCH.is_match(&self.base_branch) && !self.base_branch.contains(".."), "Invalid base branch.");
        for (key, model) in
            [("implementer_model", &self.agents.implementer_model), ("reviewer_model", &self.agents.reviewer_model)]
        {
            if let Some(model) = model {
                ensure!(MODEL.is_match(model), "agents.{key} must be a Pi model pattern such as provider/model-id.");
            }
        }
        Ok(())
    }

    pub fn load(path: &Path) -> Result<Config> {
        let text = std::fs::read_to_string(path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                Error::msg(format!("Config not found: {}. Start with gho init --help.", path.display()))
            }
            _ => Error::msg(format!("Cannot read config {}: {error}", path.display())),
        })?;
        let invalid = |detail: String| Error::msg(format!("Invalid config {}: {detail}", path.display()));
        let file: File = toml::from_str(&text).map_err(|error| invalid(error.message().to_string()))?;
        let queue = file.queue;
        let vault = file.obsidian.and_then(|o| o.vault).filter(|v| !v.as_os_str().is_empty());
        let config = Config {
            repo: queue.repo,
            owner: queue.owner,
            project_id: queue.project_id,
            project_url: queue.project_url,
            checkout: resolve(&queue.checkout)?,
            base_branch: queue.base_branch,
            vault: vault.map(|v| resolve(&v)).transpose()?,
            agents: file.agents,
        };
        config.validate().map_err(|error| invalid(error.to_string()))?;
        Ok(config)
    }

    /// The config file text. GitHub remains the task store; credentials never belong here.
    pub fn to_toml(&self) -> Result<String> {
        let file = File {
            queue: Queue {
                repo: self.repo.clone(),
                owner: self.owner.clone(),
                project_id: self.project_id.clone(),
                project_url: self.project_url.clone(),
                checkout: self.checkout.clone(),
                base_branch: self.base_branch.clone(),
            },
            obsidian: self.vault.clone().map(|vault| Obsidian { vault: Some(vault) }),
            agents: self.agents.clone(),
        };
        let body = toml::to_string(&file).map_err(|error| Error::msg(format!("Cannot write config: {error}")))?;
        Ok(format!("# GitHub remains the task store; no credentials belong in this file.\n{body}"))
    }
}
