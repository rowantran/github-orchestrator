//! Two config files in one directory: `config.toml` for settings shared by every repository (your login,
//! agent models, the vault), and `repos/OWNER/REPO.toml` for each repository's queue (Project, base branch).
//! The repository and checkout are not configured: they come from the git checkout gho runs in.

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

const GLOBAL_TEMPLATE: &str = include_str!("templates/global.toml");
const REPO_TEMPLATE: &str = include_str!("templates/repo.toml");

/// `$GHO_CONFIG_DIR`, or `~/.config/github-orchestrator`.
pub fn default_config_dir() -> PathBuf {
    let path = std::env::var_os("GHO_CONFIG_DIR").unwrap_or_else(|| "~/.config/github-orchestrator".into());
    expand_user(Path::new(&path))
}

/// The settings shared by every repository.
pub fn global_path(dir: &Path) -> PathBuf {
    dir.join("config.toml")
}

/// The settings of one repository (`OWNER/REPO`, lowercase).
pub fn repo_path(dir: &Path, repo: &str) -> Result<PathBuf> {
    validate_repo(repo)?;
    Ok(dir.join("repos").join(format!("{}.toml", repo.to_lowercase())))
}

/// The global config file `gho init` writes, with the inferred login filled in.
pub fn global_template(owner: &str) -> Result<String> {
    ensure!(OWNER.is_match(owner), "owner must be a GitHub login, not {owner:?}.");
    Ok(GLOBAL_TEMPLATE.replace("{owner}", owner))
}

/// The repository config file `gho init` writes. `project_url` is left for the user to fill in.
pub fn repo_template(repo: &str, base_branch: &str) -> Result<String> {
    validate_repo(repo)?;
    ensure!(valid_branch(base_branch), "Invalid base branch {base_branch:?}.");
    Ok(REPO_TEMPLATE.replace("{repo}", repo).replace("{base_branch}", base_branch))
}

fn valid_branch(branch: &str) -> bool {
    BRANCH.is_match(branch) && !branch.contains("..")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Config {
    /// From the checkout's origin.
    pub repo: String,
    pub owner: String,
    pub project_url: String,
    /// The checkout gho runs in. Absolute and symlink-free.
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

// The file layouts. Unknown keys are rejected so a typo cannot be silently ignored.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GlobalFile {
    owner: String,
    #[serde(default)]
    agents: Agents,
    #[serde(default)]
    obsidian: Option<Obsidian>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Obsidian {
    #[serde(default)]
    vault: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoFile {
    project_url: String,
    #[serde(default = "main")]
    base_branch: String,
}

fn main() -> String {
    "main".into()
}

/// Parse one config file; errors name the file.
fn read<T: serde::de::DeserializeOwned>(path: &Path, missing: &str) -> Result<T> {
    let text = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => Error::msg(format!("Config not found: {}. {missing}", path.display())),
        _ => Error::msg(format!("Cannot read config {}: {error}", path.display())),
    })?;
    toml::from_str(&text).map_err(|error| invalid(path, error.message()))
}

fn invalid(path: &Path, detail: impl std::fmt::Display) -> Error {
    Error::msg(format!("Invalid config {}: {detail}", path.display()))
}

impl Config {
    /// The one branch name gho uses for an issue; also how `ready` spots work in progress.
    pub fn branch(&self, number: u64) -> String {
        format!("{}/gh-{number}", self.owner)
    }

    /// Load the global config and `repo`'s config from `dir`, for the checkout at `checkout`.
    pub fn load(dir: &Path, repo: &str, checkout: &Path) -> Result<Config> {
        let global_path = global_path(dir);
        let repo_path = repo_path(dir, repo)?;
        let global: GlobalFile = read(&global_path, "Run gho init.")?;
        let local: RepoFile = read(&repo_path, &format!("Run gho init in a checkout of {repo}."))?;
        let check = |ok: bool, path: &Path, detail: &str| if ok { Ok(()) } else { Err(invalid(path, detail)) };
        check(OWNER.is_match(&global.owner), &global_path, "owner must be a GitHub login.")?;
        for (key, model) in
            [("implementer_model", &global.agents.implementer_model), ("reviewer_model", &global.agents.reviewer_model)]
        {
            let detail = format!("agents.{key} must be a Pi model pattern such as provider/model-id.");
            check(model.as_ref().is_none_or(|m| MODEL.is_match(m)), &global_path, &detail)?;
        }
        check(!local.project_url.is_empty(), &repo_path, "fill in project_url.")?;
        let detail = "project_url must be a github.com user or organization Project URL.";
        check(PROJECT_URL.is_match(&local.project_url), &repo_path, detail)?;
        check(valid_branch(&local.base_branch), &repo_path, "invalid base_branch.")?;
        let vault = global.obsidian.and_then(|o| o.vault).filter(|v| !v.as_os_str().is_empty());
        Ok(Config {
            repo: repo.to_lowercase(),
            owner: global.owner,
            project_url: local.project_url,
            checkout: resolve(checkout)?,
            base_branch: local.base_branch,
            vault: vault.map(|v| resolve(&v)).transpose()?,
            agents: global.agents,
        })
    }
}
