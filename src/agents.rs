//! `gho wait agents`: wait until implementer and reviewer agents settle.
//!
//! Agents launched with `pi --gho-agent=NAME` load the Pi extension in `extensions/agent-status.mjs`,
//! which keeps `<worktree>/.gho/agents/NAME.json` up to date. This module only reads those files; it never
//! starts, stops, or sends input to an agent.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::{Error, Result, bail, brief, ensure};

/// The directory in `.gho/` that holds one status file per agent.
pub const DIR: &str = "agents";
/// A live agent rewrites its status every 5 seconds. One older than this belongs to an agent that died.
pub const STALE: TimeDelta = TimeDelta::seconds(60);
/// How long an expected status may be missing: the time Pi needs to start after a launch.
pub const STARTUP: Duration = Duration::from_secs(30);

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{0,31}$").unwrap());

/// What an agent is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    /// Pi started and has not run its first prompt yet.
    Starting,
    Working,
    /// Waiting for an answer to a dialog in its terminal.
    Prompting,
    /// Idle: finished its run and waits for a message.
    Settled,
    /// Pi quit.
    Exited,
    /// Pi stopped updating its status without quitting, for example because it was killed.
    Lost,
}

impl Activity {
    /// Whether the agent does nothing more until someone acts.
    pub fn settled(self) -> bool {
        matches!(self, Activity::Prompting | Activity::Settled | Activity::Exited | Activity::Lost)
    }
}

/// The file the extension writes.
#[derive(Deserialize)]
struct StatusFile {
    version: u32,
    agent: String,
    state: Activity,
    since: String,
    updated_at: String,
    #[serde(default)]
    session_file: Option<String>,
    #[serde(default)]
    last_message: Option<String>,
}

/// One agent's observed status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Agent {
    /// `ISSUE/NAME`, for example `42/implementer`.
    pub id: String,
    pub issue: u64,
    pub agent: String,
    pub worktree: String,
    pub state: Activity,
    /// When the agent entered `state`.
    pub since: String,
    /// The agent's last status update.
    pub updated_at: String,
    pub session_file: Option<String>,
    /// The end of the agent's last message, when it is settled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    /// Whether this agent settled after the `--since` cursor.
    pub new: bool,
}

impl Agent {
    /// Identifies one settling of this agent: it changes each time the agent settles again.
    fn event(&self) -> Option<&str> {
        match self.state {
            // A lost agent's status stopped changing; its last update marks when that happened.
            Activity::Lost => Some(&self.updated_at),
            state if state.settled() => Some(&self.since),
            _ => None,
        }
    }
}

fn timestamp(value: &str, path: &Path) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| Error::msg(format!("Invalid timestamp {value:?} in {}.", path.display())))
}

/// Every agent status in `worktree`, in name order. A worktree without statuses has none.
pub fn read_worktree(worktree: &Path, issue: u64, now: DateTime<Utc>) -> Result<Vec<Agent>> {
    let dir = worktree.join(brief::DIR).join(DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => bail!("Cannot read {}: {error}", dir.display()),
    };
    let mut agents = Vec::new();
    for entry in entries {
        let path = entry?.path();
        // The extension writes a temporary file, then renames it to NAME.json.
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        agents.push(read_status(&path, worktree, issue, now)?);
    }
    agents.sort_by(|a, b| a.agent.cmp(&b.agent));
    Ok(agents)
}

fn read_status(path: &Path, worktree: &Path, issue: u64, now: DateTime<Utc>) -> Result<Agent> {
    let text =
        fs::read_to_string(path).map_err(|error| Error::msg(format!("Cannot read {}: {error}", path.display())))?;
    let status: StatusFile = serde_json::from_str(&text)
        .map_err(|error| Error::msg(format!("Invalid agent status {}: {error}", path.display())))?;
    let stem = path.file_stem().map(|stem| stem.to_string_lossy());
    ensure!(
        status.version == 1 && NAME.is_match(&status.agent) && stem.as_deref() == Some(status.agent.as_str()),
        "Invalid agent status {}: unknown version or agent name.",
        path.display()
    );
    timestamp(&status.since, path)?;
    let updated = timestamp(&status.updated_at, path)?;
    let state = match status.state {
        Activity::Exited => Activity::Exited,
        _ if now - updated > STALE => Activity::Lost,
        state => state,
    };
    Ok(Agent {
        id: format!("{issue}/{}", status.agent),
        issue,
        agent: status.agent,
        worktree: worktree.to_string_lossy().into_owned(),
        state,
        since: status.since,
        updated_at: status.updated_at,
        session_file: status.session_file,
        last_message: if state == Activity::Settled { status.last_message } else { None },
        new: false,
    })
}

/// The agents to wait for: all agents in an issue's worktree, or one of them.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Target {
    pub issue: u64,
    pub agent: Option<String>,
}

impl Target {
    /// `N`, `#N`, or `N/NAME`.
    pub fn parse(value: &str) -> Result<Target> {
        let usage =
            || Error::msg(format!("Expected an issue number or ISSUE/AGENT, such as 42/implementer, not {value:?}."));
        let (issue, agent) = match value.split_once('/') {
            Some((issue, agent)) => (issue, Some(agent)),
            None => (value, None),
        };
        let issue: u64 = issue.strip_prefix('#').unwrap_or(issue).parse().map_err(|_| usage())?;
        ensure!(issue > 0 && agent.is_none_or(|name| NAME.is_match(name)), "{}", usage());
        Ok(Target { issue, agent: agent.map(String::from) })
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.agent {
            Some(agent) => write!(f, "{}/{agent}", self.issue),
            None => write!(f, "{}", self.issue),
        }
    }
}

/// The settlings already reported: agent ID → the event that `Agent::event` returned.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cursor(BTreeMap<String, String>);

impl Cursor {
    /// Parse a cursor that `gho wait agents` printed. `start` is the empty cursor.
    pub fn parse(value: &str) -> Result<Cursor> {
        let mut seen = BTreeMap::new();
        if value == "start" {
            return Ok(Cursor(seen));
        }
        for part in value.split(',') {
            let parsed = part.split_once('=').filter(|(id, event)| {
                Target::parse(id).is_ok_and(|target| target.agent.is_some())
                    && DateTime::parse_from_rfc3339(event).is_ok()
            });
            let Some((id, event)) = parsed else {
                bail!("Invalid cursor {value:?}. Pass the cursor that gho wait agents printed.");
            };
            seen.insert(id.to_string(), event.to_string());
        }
        Ok(Cursor(seen))
    }
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            return f.write_str("start");
        }
        let parts: Vec<String> = self.0.iter().map(|(id, event)| format!("{id}={event}")).collect();
        f.write_str(&parts.join(","))
    }
}

/// When the wait ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// When any agent settles.
    Any,
    /// When every agent is settled at once.
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum End {
    Settled,
    Timeout,
}

/// What `gho wait agents` prints.
#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub result: End,
    pub agents: Vec<Agent>,
    /// Pass to `--since` on the next wait, so agents that are still settled do not end it again.
    pub cursor: String,
}

/// One `gho wait agents` invocation.
pub struct Watch<'a> {
    config: &'a Config,
    targets: Vec<Target>,
    mode: Mode,
    cursor: Cursor,
}

impl<'a> Watch<'a> {
    pub fn new(config: &'a Config, mut targets: Vec<Target>, mode: Mode, cursor: Cursor) -> Self {
        targets.sort();
        targets.dedup();
        Watch { config, targets, mode, cursor }
    }

    /// The issue of an issue branch `<owner>/gh-N`.
    fn issue(&self, branch: &str) -> Option<u64> {
        let number: u64 = branch.strip_prefix(&format!("{}/gh-", self.config.owner))?.parse().ok()?;
        (self.config.branch(number) == branch).then_some(number)
    }

    /// The watched agents, and the targets that have no status yet. `worktrees` maps branch to path.
    pub fn observe(
        &self,
        worktrees: &BTreeMap<String, String>,
        now: DateTime<Utc>,
    ) -> Result<(Vec<Agent>, Vec<String>)> {
        let mut agents = BTreeMap::new();
        let mut missing = Vec::new();
        if self.targets.is_empty() {
            for (branch, path) in worktrees {
                if let Some(issue) = self.issue(branch) {
                    agents.extend(read_worktree(Path::new(path), issue, now)?.into_iter().map(|a| (a.id.clone(), a)));
                }
            }
            if agents.is_empty() {
                missing.push("any agent".to_string());
            }
        }
        for target in &self.targets {
            let Some(path) = worktrees.get(&self.config.branch(target.issue)) else {
                bail!("Issue #{} has no worktree. Wait only for agents you launched.", target.issue);
            };
            let found: Vec<Agent> = read_worktree(Path::new(path), target.issue, now)?
                .into_iter()
                .filter(|agent| target.agent.as_ref().is_none_or(|name| *name == agent.agent))
                .collect();
            if found.is_empty() {
                missing.push(target.to_string());
            }
            agents.extend(found.into_iter().map(|agent| (agent.id.clone(), agent)));
        }
        Ok((agents.into_values().collect(), missing))
    }

    /// Whether the wait ends with these agents; marks the agents that settled after the cursor.
    /// Fails when a status stays missing for longer than [`STARTUP`].
    pub fn decide(&self, agents: &mut [Agent], missing: &[String], waited: Duration) -> Result<bool> {
        ensure!(
            missing.is_empty() || waited < STARTUP,
            "No agent status for {} after {}s. Launch agents with pi --gho-agent=NAME in the worktree, \
             as the github-orchestrator skill shows, and make sure this Pi package is installed.",
            missing.join(", "),
            STARTUP.as_secs()
        );
        for agent in agents.iter_mut() {
            let reported = self.cursor.0.get(&agent.id).map(String::as_str);
            agent.new = agent.event().is_some_and(|event| reported != Some(event));
        }
        let any_new = agents.iter().any(|agent| agent.new);
        Ok(match self.mode {
            Mode::Any => any_new,
            Mode::All => any_new && missing.is_empty() && agents.iter().all(|agent| agent.state.settled()),
        })
    }

    /// The outcome for these agents: the cursor covers every settled agent.
    pub fn outcome(&self, result: End, agents: Vec<Agent>) -> Outcome {
        let cursor = match result {
            End::Timeout => self.cursor.clone(),
            End::Settled => {
                Cursor(agents.iter().filter_map(|agent| Some((agent.id.clone(), agent.event()?.to_string()))).collect())
            }
        };
        Outcome { result, agents, cursor: cursor.to_string() }
    }
}
