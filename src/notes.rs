//! Optional, local-only Obsidian bridge. Completion never edits note frontmatter.
//!
//! Files live in `<vault>/.github-orchestrator/` and follow the contract in `obsidian-plugin/README.md`,
//! shared with the plugin: `links.json`, `requests/<id>.json`, `receipts/<id>.json`, and a `lock/` directory.

use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::Marker;
use yaml_rust2::{Yaml, YamlLoader};

use crate::domain::{IssueRef, digest};
use crate::paths::resolve;
use crate::{Error, Result, bail, ensure};

pub const BRIDGE: &str = ".github-orchestrator";
const SCHEMA: u32 = 1;
const COMPLETION_MAX_AGE: TimeDelta = TimeDelta::hours(24);
const FRONTMATTER_LIMIT: usize = 131_072;

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$").unwrap());
static NOTION_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$").unwrap()
});

/// A note's association with GitHub issues.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Link {
    pub id: String,
    pub note_path: String,
    /// Canonical, unique and sorted.
    pub issue_urls: Vec<String>,
    /// Lowercase dashed UUID, when the note is a Notion task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notion_page_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    schema_version: u32,
    links: Vec<Link>,
}

/// A request for the plugin to mark a note done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub schema_version: u32,
    pub id: String,
    pub link_id: String,
    pub issue_urls: Vec<String>,
    pub issue_fingerprint: String,
    pub requested_at: String,
}

/// The fields of a plugin receipt that the bridge checks.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema_version: u32,
    request_id: String,
    link_id: String,
    issue_fingerprint: String,
    status: Status,
}

/// `pending` and `stale` are inferred for requests without a receipt; the rest come from receipts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Pending,
    Processing,
    LocalAccepted,
    AlreadyDone,
    ApiUnavailable,
    Stale,
    Failed,
    RolledBack,
    Interrupted,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Processing => "processing",
            Status::LocalAccepted => "local-accepted",
            Status::AlreadyDone => "already-done",
            Status::ApiUnavailable => "api-unavailable",
            Status::Stale => "stale",
            Status::Failed => "failed",
            Status::RolledBack => "rolled-back",
            Status::Interrupted => "interrupted",
        }
    }
}

/// The latest request for a link's exact issue set, and its outcome.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionState {
    pub status: Status,
    pub request_id: String,
    pub requested_at: String,
    pub issue_fingerprint: String,
    pub receipt: Option<Value>,
}

/// Check a vault-relative Markdown path: no traversal, hidden folders, backslashes or drive letters.
pub fn note_path(value: &str) -> Result<&str> {
    let valid = !value.is_empty()
        && !value.contains(['\\', ':', '\0', '\r', '\n'])
        && value.split('/').all(|part| !part.is_empty() && !part.starts_with('.'))
        && value.to_lowercase().ends_with(".md");
    ensure!(valid, "Use a vault-relative task Markdown path without traversal or hidden folders.");
    Ok(value)
}

/// Canonical, unique, sorted issue URLs.
fn canonical_urls<S: AsRef<str>>(values: &[S]) -> Result<Vec<String>> {
    ensure!(!values.is_empty(), "A note link requires at least one GitHub issue URL.");
    let urls = values
        .iter()
        .map(|value| IssueRef::parse(value.as_ref(), None).map(|r| r.url()))
        .collect::<Result<BTreeSet<_>>>()?;
    Ok(urls.into_iter().collect())
}

fn notion_id(value: &str) -> Result<String> {
    ensure!(NOTION_ID.is_match(value), "Task note has an invalid notion_page_id.");
    let id = Uuid::parse_str(value).map_err(|_| Error::msg("Task note has an invalid notion_page_id."))?;
    Ok(id.hyphenated().to_string())
}

/// Records YAML features the bridge refuses: aliases can expand unexpectedly and tags can name types.
#[derive(Default)]
struct Unsupported {
    alias: bool,
    tag: bool,
}

impl MarkedEventReceiver for Unsupported {
    fn on_event(&mut self, event: Event, _mark: Marker) {
        match event {
            Event::Alias(_) => self.alias = true,
            Event::Scalar(_, _, _, Some(_)) | Event::SequenceStart(_, Some(_)) | Event::MappingStart(_, Some(_)) => {
                self.tag = true
            }
            _ => {}
        }
    }
}

/// Removes the lock directory when dropped.
struct Lock(PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

/// File bridge; the caller must verify all GitHub issues before requesting completion.
pub struct Notes {
    vault: PathBuf,
    bridge: PathBuf,
}

impl Notes {
    pub fn new(vault: &Path) -> Result<Self> {
        let vault = vault
            .canonicalize()
            .ok()
            .filter(|path| path.is_dir())
            .ok_or_else(|| Error::msg("Obsidian vault must be an existing directory."))?;
        let bridge = vault.join(BRIDGE);
        Ok(Notes { vault, bridge })
    }

    /// Reject paths outside the vault and symlinks anywhere below it, before any read or write.
    fn safe(&self, path: &Path) -> Result<PathBuf> {
        let escapes = || Error::msg("Path escapes the Obsidian vault.");
        let relative = path.strip_prefix(&self.vault).map_err(|_| escapes())?;
        let mut current = self.vault.clone();
        for component in relative.components() {
            let Component::Normal(part) = component else { return Err(escapes()) };
            current.push(part);
            if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
                bail!("Refusing symlink in vault path: {}", relative.display());
            }
        }
        ensure!(resolve(path)?.starts_with(&self.vault), "Path escapes the Obsidian vault.");
        Ok(path.to_path_buf())
    }

    fn mkdir(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(self.safe(path)?)?;
        self.safe(path)?;
        Ok(())
    }

    /// The bridge lock shared with the plugin: an exclusively created directory.
    fn lock(&self) -> Result<Lock> {
        self.mkdir(&self.bridge)?;
        let path = self.safe(&self.bridge.join("lock"))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Lock(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    self.safe(&path)?;
                    ensure!(
                        Instant::now() < deadline,
                        "Obsidian bridge is locked. Retry; if a process crashed, stop bridge users \
                         before removing .github-orchestrator/lock."
                    );
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    fn read_json(&self, path: &Path) -> Result<Value> {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let text = fs::read_to_string(self.safe(path)?)
            .map_err(|error| Error::msg(format!("Cannot read bridge JSON: {name}: {error}")))?;
        serde_json::from_str(&text).map_err(|error| Error::msg(format!("Cannot read bridge JSON: {name}: {error}")))
    }

    /// Write through a synced temporary file and an atomic rename.
    fn write_json(&self, path: &Path, value: &impl Serialize) -> Result<()> {
        self.safe(path)?;
        self.mkdir(path.parent().expect("bridge files have a parent"))?;
        let name = path.file_name().expect("bridge files have a name").to_string_lossy();
        let temporary = path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4()));
        let write = || -> Result<()> {
            let mut text = serde_json::to_string_pretty(value).map_err(|error| Error::msg(error.to_string()))?;
            text.push('\n');
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            self.safe(path)?;
            fs::rename(&temporary, path)?;
            Ok(())
        };
        let result = write();
        let _ = fs::remove_file(&temporary);
        result
    }

    fn registry(&self) -> Result<Vec<Link>> {
        let path = self.safe(&self.bridge.join("links.json"))?;
        if !path.exists() {
            return Ok(Vec::new());
        }
        let registry: Registry = serde_json::from_value(self.read_json(&path)?).map_err(|error| {
            Error::msg(format!("Invalid links.json: {error}; repair it before updating associations."))
        })?;
        ensure!(
            registry.schema_version == SCHEMA,
            "Invalid links.json schema; repair it before updating associations."
        );
        let mut ids = BTreeSet::new();
        let mut paths = BTreeSet::new();
        let mut notion_ids = BTreeSet::new();
        for link in &registry.links {
            ensure!(ID.is_match(&link.id), "Invalid link ID in links.json.");
            self.safe(&self.vault.join(note_path(&link.note_path)?))?;
            ensure!(
                link.issue_urls == canonical_urls(&link.issue_urls)?,
                "Issue URLs in links.json must be canonical, unique, and sorted."
            );
            ensure!(ids.insert(&link.id) && paths.insert(&link.note_path), "Duplicate link identity in links.json.");
            if let Some(id) = &link.notion_page_id {
                ensure!(
                    notion_id(id)? == *id && notion_ids.insert(id),
                    "Duplicate or noncanonical Notion identity in links.json."
                );
            }
        }
        Ok(registry.links)
    }

    /// Read a task note's YAML frontmatter; return its canonical Notion page ID, if any.
    fn task_identity(&self, note: &str) -> Result<Option<String>> {
        let path = self.safe(&self.vault.join(note_path(note)?))?;
        let unreadable =
            |error: &dyn std::fmt::Display| Error::msg(format!("Cannot read task frontmatter: {note}: {error}"));
        let file = fs::File::open(&path).map_err(|error| unreadable(&error))?;
        let mut lines = BufReader::new(file).lines();
        let first = lines.next().transpose().map_err(|error| unreadable(&error))?.unwrap_or_default();
        ensure!(
            first.trim_start_matches('\u{feff}').trim() == "---",
            "Task note must have YAML frontmatter with type: task."
        );
        let mut text = String::new();
        let mut terminated = false;
        for line in lines {
            let line = line.map_err(|error| unreadable(&error))?;
            if line.trim() == "---" {
                terminated = true;
                break;
            }
            text.push_str(&line);
            text.push('\n');
            ensure!(text.len() <= FRONTMATTER_LIMIT, "Task frontmatter exceeds the bridge size limit.");
        }
        ensure!(terminated, "Task note has unterminated YAML frontmatter.");

        let mut unsupported = Unsupported::default();
        Parser::new_from_str(&text).load(&mut unsupported, true).map_err(|error| unreadable(&error))?;
        ensure!(!unsupported.alias, "Task frontmatter aliases are not supported by the bridge.");
        ensure!(!unsupported.tag, "Task frontmatter tags are not supported by the bridge.");
        let documents = YamlLoader::load_from_str(&text).map_err(|error| unreadable(&error))?;
        let [metadata @ Yaml::Hash(_)] = documents.as_slice() else {
            bail!("Only notes with type: task can be linked.");
        };
        ensure!(metadata["type"].as_str() == Some("task"), "Only notes with type: task can be linked.");
        let page_id = &metadata["notion_page_id"];
        if page_id.is_badvalue() {
            ensure!(
                metadata["notion_managed"].as_bool() != Some(true),
                "Managed Notion task is missing notion_page_id."
            );
            return Ok(None);
        }
        let page_id = page_id.as_str().ok_or_else(|| Error::msg("Task note has an invalid notion_page_id."))?;
        notion_id(page_id).map(Some)
    }

    /// Canonical associations. Does not read note bodies or change note files.
    pub fn links(&self) -> Result<Vec<Link>> {
        let _lock = self.lock()?;
        let mut links = self.registry()?;
        links.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(links)
    }

    /// Replace this note's issue set, preserving its stable association ID.
    pub fn link<S: AsRef<str>>(&self, note: &str, issue_urls: &[S]) -> Result<Link> {
        self.update_link(note, issue_urls, false)
    }

    /// Atomically add issues to this note's existing association.
    pub fn add<S: AsRef<str>>(&self, note: &str, issue_urls: &[S]) -> Result<Link> {
        self.update_link(note, issue_urls, true)
    }

    fn update_link<S: AsRef<str>>(&self, note: &str, issue_urls: &[S], union: bool) -> Result<Link> {
        let note = note_path(note)?;
        let mut urls = canonical_urls(issue_urls)?;
        let _lock = self.lock()?;
        let notion_page_id = self.task_identity(note)?;
        let mut links = self.registry()?;
        let matching: Vec<usize> = (0..links.len())
            .filter(|&i| {
                links[i].note_path == note || (notion_page_id.is_some() && links[i].notion_page_id == notion_page_id)
            })
            .collect();
        ensure!(matching.len() <= 1, "Conflicting path and Notion identities in links.json.");
        let previous = matching.first().map(|&i| links.remove(i));
        if let Some(previous) = &previous {
            ensure!(
                previous.notion_page_id == notion_page_id,
                "Task identity changed at this path; resolve the old association first."
            );
            if union {
                let merged: BTreeSet<String> = previous.issue_urls.iter().cloned().chain(urls).collect();
                urls = merged.into_iter().collect();
            }
        }
        let link = Link {
            id: previous.map_or_else(|| Uuid::new_v4().to_string(), |previous| previous.id),
            note_path: note.into(),
            issue_urls: urls,
            notion_page_id,
        };
        links.push(link.clone());
        links.sort_by(|a, b| a.id.cmp(&b.id));
        self.write_json(&self.bridge.join("links.json"), &Registry { schema_version: SCHEMA, links })?;
        Ok(link)
    }

    /// The registry's copy of `link`, which must be unchanged. Call while holding the lock.
    fn current(&self, link: &Link) -> Result<Link> {
        let current = self.registry()?.into_iter().find(|item| item.id == link.id);
        match current {
            Some(current) if current == *link => Ok(current),
            _ => bail!("Note association changed; reload links and recheck all GitHub issues."),
        }
    }

    /// The latest request for this link's exact issue set, for caller-controlled duplicate suppression.
    pub fn completion_state(&self, link: &Link) -> Result<Option<CompletionState>> {
        let _lock = self.lock()?;
        let current = self.current(link)?;
        let fingerprint = digest(&current.issue_urls);
        let directory = self.safe(&self.bridge.join("requests"))?;
        if !directory.exists() {
            return Ok(None);
        }
        // Newest by (requestedAt, file modification time, ID).
        type Key = (DateTime<Utc>, u128, String);
        let mut latest: Option<(Key, CompletionRequest)> = None;
        for entry in fs::read_dir(&directory)? {
            let path = entry?.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".json").filter(|stem| ID.is_match(stem)) else { continue };
            let value = self.read_json(&path)?;
            ensure!(value.is_object(), "Invalid completion request: {name}");
            if value["linkId"] != current.id.as_str() || value["issueFingerprint"] != fingerprint.as_str() {
                continue;
            }
            let mismatch = || Error::msg(format!("Completion request identity mismatch: {name}"));
            let request: CompletionRequest = serde_json::from_value(value).map_err(|_| mismatch())?;
            ensure!(
                request.schema_version == SCHEMA && request.id == stem && request.issue_urls == current.issue_urls,
                "Completion request identity mismatch: {name}"
            );
            let requested_at = DateTime::parse_from_rfc3339(&request.requested_at)
                .map_err(|_| Error::msg(format!("Invalid completion request timestamp: {name}")))?
                .to_utc();
            let modified = self.safe(&path)?.metadata()?.modified()?;
            let modified = modified.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
            let key = (requested_at, modified, stem.to_string());
            if latest.as_ref().is_none_or(|(best, _)| key > *best) {
                latest = Some((key, request));
            }
        }
        let Some(((requested_at, _, _), request)) = latest else { return Ok(None) };
        let path = self.safe(&self.bridge.join("receipts").join(format!("{}.json", request.id)))?;
        let (status, receipt) = if path.exists() {
            let value = self.read_json(&path)?;
            let mismatch = || Error::msg("Completion receipt identity or status mismatch; inspect it before retrying.");
            let receipt: Receipt = serde_json::from_value(value.clone()).map_err(|_| mismatch())?;
            let valid = receipt.schema_version == SCHEMA
                && receipt.request_id == request.id
                && receipt.link_id == current.id
                && receipt.issue_fingerprint == fingerprint
                && receipt.status != Status::Pending;
            if !valid {
                return Err(mismatch());
            }
            (receipt.status, Some(value))
        } else if Utc::now() - requested_at > COMPLETION_MAX_AGE {
            (Status::Stale, None)
        } else {
            (Status::Pending, None)
        };
        Ok(Some(CompletionState {
            status,
            request_id: request.id,
            requested_at: request.requested_at,
            issue_fingerprint: fingerprint,
            receipt,
        }))
    }

    /// Queue one explicit completion attempt. Only call after verifying every issue on GitHub.
    pub fn request_completion(&self, link: &Link) -> Result<CompletionRequest> {
        let _lock = self.lock()?;
        let current = self.current(link)?;
        let request = CompletionRequest {
            schema_version: SCHEMA,
            id: Uuid::new_v4().to_string(),
            link_id: current.id,
            issue_fingerprint: digest(&current.issue_urls),
            issue_urls: current.issue_urls,
            requested_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        self.write_json(&self.bridge.join("requests").join(format!("{}.json", request.id)), &request)?;
        Ok(request)
    }
}
