//! The gho command: register work, find ready work, create worktrees. Agents are launched by the orchestrator.

use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use serde::Serialize;

use crate::config::{Config, default_config_dir, global_path, global_template, repo_path, repo_template};
use crate::domain::{IssueRef, StateReason};
use crate::github::GitHub;
use crate::notes::{Notes, Status, note_path};
use crate::paths::{expand_user, resolve};
use crate::process::{Cmd, Runner, System, which};
use crate::work::{Blocker, Entry, Issues, State, classify, survey};
use crate::workspace::{Created, Workspace, locate, origin_default_branch};
use crate::{Error, Result, bail, brief, ensure};

#[derive(Debug, Parser)]
#[command(name = "gho", version, about = "Your GitHub issue queue → ready work → Worktrunk worktrees.")]
pub struct Cli {
    /// Directory of config.toml and repos/OWNER/REPO.toml [default: $GHO_CONFIG_DIR, or
    /// ~/.config/github-orchestrator]
    #[arg(long, global = true)]
    pub config_dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create the global config and this checkout's repository config, if missing; never overwrites
    Init,
    /// Check git, gh, wt and GitHub Project access
    Doctor,
    /// Print the loaded config, including the agent models, as JSON
    Config,
    /// List queue issues that are ready to start (blockers done, or ready for review to stack on)
    Ready {
        /// Also list blocked, in-progress and ready-for-review issues
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Create a ready issue's branch and worktree with a task brief in .gho/brief.md; prints JSON
    Worktree {
        /// Issue number or URL
        issue: String,
        /// Branch or commit to start from, even if the issue is not ready [default: only ready issues; the top of
        /// their stack of blockers under review, else latest origin/<base branch>]
        #[arg(long)]
        base: Option<String>,
    },
    /// Register work as GitHub issues
    #[command(subcommand)]
    Task(TaskCommand),
    /// Optional TaskNotes bridge
    #[command(subcommand)]
    Notes(NotesCommand),
}

#[derive(Debug, Subcommand)]
pub enum TaskCommand {
    /// Create an issue assigned to you and add it to the Project
    Create {
        #[arg(long)]
        title: String,
        #[arg(long)]
        body_file: PathBuf,
        /// Issue number/URL; repeat or comma-separate
        #[arg(long)]
        blocked_by: Vec<String>,
        /// Also link the new issue to this vault-relative task note
        #[arg(long)]
        note: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum NotesCommand {
    /// Replace an existing task note's complete set of linked GitHub issues
    Link {
        note: String,
        #[arg(required = true)]
        issues: Vec<String>,
    },
    /// List note associations
    List,
    /// Request TaskNotes completion for notes whose issues are all done
    Complete {
        /// Retry failed or stale requests
        #[arg(long)]
        retry: bool,
    },
    /// Copy the built plugin into the configured vault; never enable it
    Install {
        #[arg(long)]
        yes: bool,
    },
}

/// Run `gho` with these arguments; returns the exit code.
pub fn main(args: impl IntoIterator<Item = impl Into<OsString> + Clone>) -> i32 {
    let cli = Cli::parse_from(args);
    let mut out = io::stdout().lock();
    match run(cli, &System, &mut out) {
        Ok(()) => 0,
        Err(error) => {
            let _ = out.flush();
            eprintln!("gho: {error}");
            1
        }
    }
}

pub fn run(cli: Cli, runner: &dyn Runner, out: &mut dyn Write) -> Result<()> {
    let config_dir = cli.config_dir.map_or_else(default_config_dir, |path| expand_user(&path));
    let cwd = std::env::current_dir()?;
    let command = match cli.command {
        Command::Init => return init(&config_dir, &cwd, runner, out),
        command => command,
    };
    let config = load(&config_dir, &cwd, runner)?;
    if let Command::Config = command {
        return print_json(out, &config);
    }
    let github = GitHub::new(&config.repo, &config.project_url, &config.owner, runner)?;
    let workspace = Workspace::new(&config, runner);
    match command {
        Command::Init | Command::Config => unreachable!("handled above"),
        Command::Doctor => doctor(&config, &github, &workspace, out),
        Command::Ready { all, json } => display_ready(&survey(&config, &github, &workspace)?, all, json, out),
        Command::Worktree { issue, base } => {
            let reference = IssueRef::new(&config.repo, worktree_number(&config, &issue)?)?;
            let (title, base) = match base {
                Some(base) => (github.issue(&reference)?.title, Some(base)),
                None => {
                    let entry = classify(&config, &github, &workspace, &reference)?;
                    let base = stack_branch(&config, &entry)?.map(|branch| workspace.fetch(&branch)).transpose()?;
                    (entry.title, base)
                }
            };
            let created = workspace.create(reference.number(), base.as_deref())?;
            let brief = write_brief(&config, &reference, &title, &created).map_err(|error| {
                Error::msg(format!("Created the worktree at {}, but not its brief: {error}", created.path))
            })?;
            print_json(out, &Started { created, brief })
        }
        Command::Task(TaskCommand::Create { title, body_file, blocked_by, note }) => {
            let body = fs::read_to_string(&body_file)
                .map_err(|error| Error::msg(format!("Cannot read {}: {error}", body_file.display())))?;
            ensure!(!body.trim().is_empty(), "Issue body is empty.");
            let blockers = blocked_by
                .iter()
                .flat_map(|group| group.split(','))
                .map(|part| IssueRef::parse(part.trim(), Some(&config.repo)))
                .collect::<Result<Vec<_>>>()?;
            // Check the note before creating anything, so a bad note cannot orphan a new issue.
            let notes = match &note {
                Some(note) => Some((notes_for(&config)?, note_path(note)?)),
                None => None,
            };
            let url = github.create_issue(&title, &body, &blockers)?.reference.url();
            writeln!(out, "{url}")?;
            out.flush()?;
            if let Some((notes, note)) = notes {
                let link = notes.add(note, &[&url]).map_err(|error| {
                    Error::msg(format!("Issue was created at {url}; note linking failed: {error}. Do not recreate it."))
                })?;
                print_json(out, &link)?;
            }
            Ok(())
        }
        Command::Notes(command) => {
            let notes = notes_for(&config)?;
            match command {
                NotesCommand::Link { note, issues } => {
                    let urls = issues
                        .iter()
                        .map(|value| IssueRef::parse(value, Some(&config.repo)).map(|r| r.url()))
                        .collect::<Result<Vec<_>>>()?;
                    print_json(out, &notes.link(&note, &urls)?)
                }
                NotesCommand::List => print_json(out, &notes.links()?),
                NotesCommand::Complete { retry } => complete_notes(&github, &notes, retry, out),
                NotesCommand::Install { yes } => install_plugin(&config, yes, out),
            }
        }
    }
}

/// The result of `gho worktree`.
#[derive(Serialize)]
struct Started {
    #[serde(flatten)]
    created: Created,
    /// The task brief to give implementer and reviewer agents.
    brief: PathBuf,
}

fn write_brief(config: &Config, reference: &IssueRef, title: &str, created: &Created) -> Result<PathBuf> {
    let facts = brief::Facts {
        number: reference.number(),
        title,
        url: &reference.url(),
        repo: &config.repo,
        branch: &created.branch,
        base_branch: &created.base_branch,
    };
    brief::write(Path::new(&created.path), &brief::render(&facts))
}

fn print_json(out: &mut dyn Write, value: &impl Serialize) -> Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(|error| Error::msg(error.to_string()))?;
    writeln!(out, "{text}")?;
    Ok(())
}

/// Ask before a change unless `yes`. Refuses when there is nobody to ask.
pub fn confirm(yes: bool, interactive: bool, ask: impl FnOnce() -> io::Result<String>) -> Result<()> {
    if yes {
        return Ok(());
    }
    ensure!(interactive, "This action needs --yes or an interactive confirmation.");
    let answer = ask()?.trim().to_lowercase();
    ensure!(answer == "y" || answer == "yes", "Canceled; no change made.");
    Ok(())
}

fn ask_terminal(message: &str, yes: bool) -> Result<()> {
    confirm(yes, io::stdin().is_terminal(), || {
        print!("{message} [y/N] ");
        io::stdout().flush()?;
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        Ok(line)
    })
}

/// The config for the checkout that contains `cwd`.
pub fn load(config_dir: &Path, cwd: &Path, runner: &dyn Runner) -> Result<Config> {
    let Some((checkout, repo)) = locate(cwd, runner)? else {
        bail!("Run gho inside a checkout of a GitHub repository.");
    };
    Config::load(&resolve(config_dir)?, &repo, &checkout)
}

/// Create whichever of the global config and the repository config of the checkout at `cwd` is missing,
/// filled in with what can be inferred. Never overwrites a config.
pub fn init(config_dir: &Path, cwd: &Path, runner: &dyn Runner, out: &mut dyn Write) -> Result<()> {
    let config_dir = resolve(config_dir)?;
    // Each config file, with its text and the inferred values when it is missing. Everything is inferred
    // before anything is written, so a failure leaves no partial setup.
    let mut files: Vec<(PathBuf, Option<(String, String)>)> = Vec::new();
    let global = global_path(&config_dir);
    let missing = (!global.exists())
        .then(|| {
            let cmd = Cmd::new(["gh", "api", "--hostname", "github.com", "user", "--jq", ".login"])
                .env("GH_HOST", "github.com");
            let owner = runner.run(&cmd)?.trim().to_string();
            Ok::<_, Error>((global_template(&owner)?, format!("owner {owner}")))
        })
        .transpose()?;
    files.push((global, missing));
    let checkout = locate(cwd, runner)?;
    if let Some((checkout, repo)) = &checkout {
        let path = repo_path(&config_dir, repo)?;
        let missing = (!path.exists())
            .then(|| {
                let base = origin_default_branch(checkout, runner).unwrap_or_else(|| "main".into());
                Ok::<_, Error>((repo_template(repo, &base)?, format!("{repo}, base branch {base}")))
            })
            .transpose()?;
        files.push((path, missing));
    }
    for (path, missing) in &files {
        let Some((text, inferred)) = missing else {
            writeln!(out, "Exists, unchanged: {}", path.display())?;
            continue;
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::OpenOptions::new().write(true).create_new(true).open(path)?.write_all(text.as_bytes())?;
        writeln!(out, "Created {} ({inferred})", path.display())?;
    }
    match files.get(1) {
        Some((path, Some(_))) => writeln!(out, "Next: set project_url in {}, then run gho doctor.", path.display())?,
        Some((_, None)) => writeln!(out, "Next: gho doctor")?,
        None => writeln!(out, "Not in a git checkout. Run gho init in a checkout to configure its repository.")?,
    }
    Ok(())
}

fn notes_for(config: &Config) -> Result<Notes> {
    match &config.vault {
        Some(vault) => Notes::new(vault),
        None => bail!("Set [obsidian].vault in your queue config first."),
    }
}

/// The issue number for `gho worktree`, which only works on the configured repository.
pub fn worktree_number(config: &Config, value: &str) -> Result<u64> {
    let reference = IssueRef::parse(value, Some(&config.repo))?;
    ensure!(reference.repo() == config.repo.to_lowercase(), "Worktrees are only created for {} issues.", config.repo);
    Ok(reference.number())
}

/// The blocker branch to start a ready issue from without `--base`: the top of its stack of blockers
/// under review, or `None` for the latest base branch. Refuses issues that are not ready.
pub fn stack_branch(config: &Config, entry: &Entry) -> Result<Option<String>> {
    match &entry.state {
        State::Ready { stack_on } => Ok(stack_on.last().map(|&top| config.branch(top))),
        state => bail!("{} Use --base to start it anyway.", not_ready(entry.number, state, entry)),
    }
}

/// Why issue `number` cannot be started.
fn not_ready(number: u64, state: &State, entry: &Entry) -> String {
    match state {
        State::Ready { .. } => unreachable!("ready issues can start"),
        State::Blocked => {
            let waits: Vec<String> = entry
                .blockers
                .iter()
                .filter(|blocker| blocker.state != State::Done)
                .map(|blocker| format!("{}#{} ({})", blocker.repo, blocker.number, blocker_place(blocker)))
                .collect();
            format!("Issue #{number} is blocked: it waits on {}.", waits.join(", "))
        }
        State::InProgress => match &entry.worktree {
            Some(worktree) => format!("Issue #{number} is already in progress in {worktree}."),
            None => format!("Issue #{number} is already in progress on branch {}.", entry.branch),
        },
        State::ReadyForReview { pull_request } => {
            format!(
                "Issue #{number} already has an open pull request: {}. Continue on {}.",
                pull_request.url, pull_request.head
            )
        }
        State::Done => format!("Issue #{number} is already done."),
        State::Closed { .. } => format!("Issue #{number} is closed without being completed."),
    }
}

/// A blocker's state in words, for `gho ready` and refusals.
fn blocker_place(blocker: &Blocker) -> String {
    match (&blocker.state, &blocker.branch) {
        (State::ReadyForReview { pull_request }, _) => format!("ready for review: {}", pull_request.url),
        (State::InProgress, Some(branch)) => format!("in progress on {branch}"),
        (State::Ready { .. }, _) => "not started".into(),
        (State::Closed { reason: Some(StateReason::Duplicate) }, _) => "closed as duplicate".into(),
        (State::Closed { .. }, _) => "closed as not planned".into(),
        (state, _) => state.label().to_lowercase().replace('_', " "),
    }
}

pub fn display_ready(items: &[Entry], all: bool, json: bool, out: &mut dyn Write) -> Result<()> {
    let items: Vec<&Entry> = items.iter().filter(|item| all || item.state.is_ready()).collect();
    if json {
        return print_json(out, &items);
    }
    if items.is_empty() {
        let message =
            if all { "Your queue is empty (open issues assigned to you in the Project)." } else { "Nothing ready." };
        writeln!(out, "{message}")?;
    }
    for item in items {
        writeln!(out, "{:<16} #{:<6} {}", item.state.label(), item.number, item.title)?;
        if let Some(worktree) = &item.worktree {
            writeln!(out, "{:25}{worktree}", "")?;
        }
        match &item.state {
            State::ReadyForReview { pull_request } => writeln!(out, "{:25}review {}", "", pull_request.url)?,
            State::Ready { stack_on } if !stack_on.is_empty() => {
                let stack: Vec<String> = stack_on.iter().map(|n| format!("#{n}")).collect();
                writeln!(out, "{:25}stacks on {}", "", stack.join(" → "))?;
            }
            _ => {}
        }
        for blocker in item.blockers.iter().filter(|blocker| blocker.state != State::Done) {
            let place = blocker_place(blocker);
            writeln!(out, "{:25}waits on {}#{} ({place})", "", blocker.repo, blocker.number)?;
        }
    }
    Ok(())
}

fn doctor(config: &Config, github: &GitHub, workspace: &Workspace, out: &mut dyn Write) -> Result<()> {
    let mut failed = false;
    for name in ["git", "gh", "wt"] {
        match which(name) {
            Some(path) => writeln!(out, "OK   {name}: {}", path.display())?,
            None => {
                writeln!(out, "FAIL {name}: not found")?;
                failed = true;
            }
        }
    }
    let checkout = workspace.verify_checkout();
    if checkout.is_ok() {
        writeln!(out, "OK   checkout {} matches {}", config.checkout.display(), config.repo)?;
    }
    match checkout.and_then(|()| github.queue()) {
        Ok(queue) => {
            writeln!(out, "OK   GitHub Project access; {} open issue(s) assigned to {}", queue.len(), config.owner)?
        }
        Err(error) => {
            writeln!(out, "FAIL {error}")?;
            failed = true;
        }
    }
    for (role, model) in
        [("implementer", &config.agents.implementer_model), ("reviewer", &config.agents.reviewer_model)]
    {
        match model {
            Some(model) => writeln!(out, "OK   {role} model: {model}")?,
            None => writeln!(out, "WARN {role} model: not set; add {role}_model under [agents] in the config")?,
        }
    }
    ensure!(!failed, "Doctor found problems. GitHub Projects access may need: gh auth refresh -s project");
    Ok(())
}

/// Request completion for each linked note whose issues are all completed, once per issue set.
pub fn complete_notes(github: &dyn Issues, notes: &Notes, retry: bool, out: &mut dyn Write) -> Result<()> {
    let links = notes.links()?;
    if links.is_empty() {
        writeln!(out, "No linked task notes.")?;
        return Ok(());
    }
    for link in links {
        if let Some(state) = notes.completion_state(&link)? {
            let status = state.status.as_str();
            if matches!(
                state.status,
                Status::Pending | Status::Processing | Status::LocalAccepted | Status::AlreadyDone
            ) {
                writeln!(out, "{}: {status}", link.note_path)?;
                continue;
            }
            if !retry {
                writeln!(out, "{}: {status}; inspect the receipt, then use --retry", link.note_path)?;
                continue;
            }
        }
        let mut open = Vec::new();
        for url in &link.issue_urls {
            if !github.issue(&IssueRef::parse(url, None)?)?.completed() {
                open.push(url.as_str());
            }
        }
        if !open.is_empty() {
            writeln!(out, "Waiting: {}: not completed: {}", link.note_path, open.join(", "))?;
            continue;
        }
        print_json(out, &notes.request_completion(&link)?)?;
    }
    Ok(())
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn install_plugin(config: &Config, yes: bool, out: &mut dyn Write) -> Result<()> {
    let vault = config.vault.as_deref().expect("notes_for checked the vault");
    ask_terminal("Copy the built GitHub Orchestrator plugin into your vault (without enabling it)?", yes)?;
    // The plugin is built from a clone of this repository, not shipped in the binary.
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("obsidian-plugin");
    let destination = vault.join(".obsidian/plugins/github-orchestrator");
    let names = ["main.js", "manifest.json"];
    ensure!(
        names.iter().all(|name| source.join(name).is_file()),
        "Build the optional plugin first: cd {} && npm ci && npm run build",
        source.display()
    );
    ensure!(
        !destination.ancestors().take_while(|path| *path != vault).any(is_symlink),
        "Refusing a symlink in the plugin installation path."
    );
    ensure!(
        !names.iter().any(|name| is_symlink(&destination.join(name))),
        "Refusing to replace a symlinked plugin file."
    );
    fs::create_dir_all(&destination)?;
    for name in names {
        fs::copy(source.join(name), destination.join(name))?;
    }
    writeln!(out, "Installed to {}. Enable GitHub Orchestrator in Obsidian Community plugins.", destination.display())?;
    Ok(())
}
