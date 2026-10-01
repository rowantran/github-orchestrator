//! Read existing tmux panes and select one that still belongs to a task.
//! This module never creates sessions, windows or panes, or sends input to them.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::process::{Cmd, Runner};
use crate::{Error, Result, ensure};

// Never interpolate a request into a format. Omit records containing control characters so a
// newline or tab in a name, path or user option cannot forge another record. tmux expands variable
// values once; their contents are not evaluated as formats or shell commands.
const PANE_FORMAT: &str = concat!(
    "#{?#{m/r:[[:cntrl:]],",
    "#{session_name}#{window_name}#{pane_current_path}#{@gho_repo}#{@gho_issue}},,",
    "#{pane_id}\t#{session_id}\t#{window_id}\t#{pane_dead}\t",
    "#{session_name}\t#{window_name}\t#{pane_current_path}\t#{@gho_repo}\t#{@gho_issue}}"
);

/// An existing, live pane. Session and window are display names; only the pane ID is a focus target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pane {
    pub id: String,
    pub session: String,
    pub window: String,
}

#[derive(Debug, Clone)]
struct LivePane {
    pane: Pane,
    session_id: String,
    window_id: String,
    path: Option<PathBuf>,
    repo: String,
    issue: String,
}

/// One read of the server. Reuse this for all tasks in a dashboard refresh, not for focus requests.
#[derive(Debug, Clone)]
pub struct Snapshot {
    panes: Vec<LivePane>,
}

impl Snapshot {
    /// Tagged panes must match both repository and issue. Without matching tags, exactly one
    /// untagged pane at the canonical worktree root is accepted. Subdirectories are deliberately
    /// excluded: a process's working directory alone does not identify the task it is handling.
    pub fn panes(&self, repo: &str, worktree: Option<&str>, issue: u64) -> Vec<Pane> {
        self.matching(repo, worktree, issue).into_iter().map(|live| live.pane.clone()).collect()
    }

    fn matching(&self, repo: &str, worktree: Option<&str>, issue: u64) -> Vec<&LivePane> {
        let issue = issue.to_string();
        let mut tagged: Vec<_> =
            self.panes.iter().filter(|live| live.repo.eq_ignore_ascii_case(repo) && live.issue == issue).collect();
        if !tagged.is_empty() {
            // A linked window can expose the same pane through several sessions. A focus request
            // contains only a pane ID, so offer that target once, with its deterministic session.
            tagged.dedup_by(|a, b| a.pane.id == b.pane.id);
            return tagged;
        }
        let Some(root) = worktree.and_then(canonical_directory) else {
            return Vec::new();
        };
        let mut candidates = self
            .panes
            .iter()
            .filter(|live| live.repo.is_empty() && live.issue.is_empty() && live.path.as_ref() == Some(&root));
        match (candidates.next(), candidates.next()) {
            (Some(pane), None) => vec![pane],
            _ => Vec::new(),
        }
    }
}

pub struct Tmux<'a> {
    runner: &'a dyn Runner,
    session: Option<String>,
}

impl<'a> Tmux<'a> {
    pub fn new(runner: &'a dyn Runner, session: Option<&str>) -> Self {
        Self { runner, session: session.map(str::to_owned) }
    }

    /// Exactly one tmux subprocess. An explicit session is matched literally in Rust, never passed
    /// as tmux target syntax. Otherwise use the inherited session, or all panes on the default
    /// server when not running inside tmux. Missing tmux/server/session is an error for the caller
    /// to report as an optional-integration warning.
    pub fn snapshot(&self) -> Result<Snapshot> {
        let inherited = std::env::var_os("TMUX").is_some_and(|value| !value.is_empty());
        let scope = if self.session.is_none() && inherited { "-s" } else { "-a" };
        let output = self.run(&["list-panes", scope, "-F", PANE_FORMAT])?;
        let mut panes = Vec::new();
        let mut found_session = self.session.is_none();
        for line in output.lines().filter(|line| !line.is_empty()) {
            let fields: Vec<_> = line.split('\t').collect();
            ensure!(fields.len() == 9, "Unexpected tmux pane data; refusing to guess pane ownership.");
            let (id, session_id, window_id, dead, session, window, path, repo, issue) =
                (fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], fields[7], fields[8]);
            ensure!(
                valid_id(id, '%') && valid_id(session_id, '$') && valid_id(window_id, '@'),
                "Unexpected tmux pane identifiers; refusing to focus a pane."
            );
            ensure!(dead == "0" || dead == "1", "Unexpected tmux pane liveness value.");
            ensure!(
                fields.iter().all(|field| !field.chars().any(char::is_control)),
                "Unexpected control characters in tmux pane data."
            );
            if self.session.as_deref().is_some_and(|requested| requested != session) {
                continue;
            }
            found_session = true;
            if dead == "1" {
                continue;
            }
            panes.push(LivePane {
                pane: Pane { id: id.into(), session: session.into(), window: window.into() },
                session_id: session_id.into(),
                window_id: window_id.into(),
                path: canonical_directory(path),
                repo: repo.into(),
                issue: issue.into(),
            });
        }
        ensure!(found_session, "The requested tmux session is unavailable; refresh or choose an existing session.");
        // Linked windows can appear in more than one session. Keep all memberships so an explicit
        // session remains meaningful and the untagged fallback fails closed on ambiguous results.
        panes.sort_by(|a, b| (&a.pane.id, &a.session_id, &a.window_id).cmp(&(&b.pane.id, &b.session_id, &b.window_id)));
        Ok(Snapshot { panes })
    }

    pub fn panes(&self, repo: &str, worktree: Option<&str>, issue: u64) -> Result<Vec<Pane>> {
        Ok(self.snapshot()?.panes(repo, worktree, issue))
    }

    /// Re-read live membership immediately before selecting. The caller's pane ID must be present
    /// and still belong to this task. Select only within the verified session; do not switch clients
    /// from unrelated sessions. Clients already attached to this session see the selected pane.
    pub fn focus(&self, repo: &str, worktree: Option<&str>, issue: u64, pane: &str) -> Result<()> {
        ensure!(valid_id(pane, '%'), "Invalid tmux pane ID; expected % followed by digits.");
        let snapshot = self.snapshot()?;
        let live = snapshot
            .matching(repo, worktree, issue)
            .into_iter()
            .find(|live| live.pane.id == pane)
            .ok_or_else(|| Error::msg("The tmux pane no longer belongs to this task; refresh the dashboard."))?;
        // Numeric server-provided IDs avoid tmux's fuzzy name matching and command separators.
        // Qualify the window by its session because a window may be linked into several sessions.
        let window = format!("{}:{}", live.session_id, live.window_id);
        self.run(&["select-window", "-t", &window])?;
        self.run(&["select-pane", "-t", &live.pane.id])?;
        Ok(())
    }

    fn run(&self, args: &[&str]) -> Result<String> {
        // -N forbids starting a server. The inherited TMUX selects the user's existing server.
        self.runner.run(&Cmd::new(["tmux", "-N"].into_iter().chain(args.iter().copied())).timeout(5))
    }
}

fn valid_id(value: &str, prefix: char) -> bool {
    value.strip_prefix(prefix).is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}

fn canonical_directory(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    canonical.is_dir().then_some(canonical)
}
