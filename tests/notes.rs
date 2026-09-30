//! All note tests use temporary vaults, never the user's Obsidian directory.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::thread;

use chrono::{TimeDelta, Utc};
use github_orchestrator::domain::digest;
use github_orchestrator::notes::{CompletionRequest, Notes, Status};
use serde_json::{Value, json};
use tempfile::TempDir;

const URL: &str = "https://github.com/example/repo/issues/1";
const URL2: &str = "https://github.com/example/repo/issues/2";
const NOTION_ID: &str = "138cea45-47b4-4284-8362-f67377f236fa";

fn vault() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().canonicalize().unwrap();
    fs::create_dir(path.join("Tasks")).unwrap();
    fs::write(path.join("Tasks/task.md"), b"---\r\ntype: task\r\nstatus: Not started\r\n---\r\n# Private\r\n").unwrap();
    (dir, path)
}

fn bridge(vault: &Path) -> PathBuf {
    vault.join(".github-orchestrator")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn fails<T: std::fmt::Debug>(result: github_orchestrator::Result<T>, needle: &str) {
    let error = result.expect_err("expected an error");
    assert!(error.to_string().contains(needle), "{error} should mention {needle:?}");
}

#[test]
fn link_is_stable_and_only_updates_bridge() {
    let (_dir, vault) = vault();
    let original = fs::read(vault.join("Tasks/task.md")).unwrap();
    let notes = Notes::new(&vault).unwrap();
    let first = notes.link("Tasks/task.md", &[URL2, URL, "https://github.com/EXAMPLE/REPO/issues/1"]).unwrap();
    assert_eq!(first.issue_urls, [URL, URL2]);
    let second = notes.link("Tasks/task.md", &[URL]).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(notes.links().unwrap(), std::slice::from_ref(&second));
    assert_eq!(
        read_json(&bridge(&vault).join("links.json")),
        json!({"schemaVersion": 1, "links": [{"id": second.id, "notePath": "Tasks/task.md", "issueUrls": [URL]}]})
    );
    assert_eq!(fs::read(vault.join("Tasks/task.md")).unwrap(), original);
    assert!(!bridge(&vault).join("lock").exists());
}

#[test]
fn infers_canonical_notion_id_and_preserves_link_on_rename() {
    let (_dir, vault) = vault();
    let compact = NOTION_ID.replace('-', "").to_uppercase();
    fs::write(
        vault.join("Tasks/task.md"),
        format!("---\ntype: task\nnotion_managed: true\nnotion_page_id: {compact}\n---\n"),
    )
    .unwrap();
    let notes = Notes::new(&vault).unwrap();
    let first = notes.link("Tasks/task.md", &[URL]).unwrap();
    assert_eq!(first.notion_page_id.as_deref(), Some(NOTION_ID));
    fs::rename(vault.join("Tasks/task.md"), vault.join("Tasks/renamed.md")).unwrap();
    let renamed = notes.link("Tasks/renamed.md", &[URL2]).unwrap();
    assert_eq!(renamed.id, first.id);
    assert_eq!(renamed.note_path, "Tasks/renamed.md");
    assert_eq!(notes.links().unwrap().len(), 1);
}

#[test]
fn request_binds_exact_issue_set_without_editing_note() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    let link = notes.link("Tasks/task.md", &[URL, URL2]).unwrap();
    let before = fs::read(vault.join("Tasks/task.md")).unwrap();
    let request = notes.request_completion(&link).unwrap();
    assert_eq!(request.link_id, link.id);
    assert_eq!(request.issue_urls, link.issue_urls);
    assert_eq!(request.issue_fingerprint, digest(&[URL.into(), URL2.into()]));
    assert!(request.requested_at.ends_with('Z'));
    let saved: CompletionRequest =
        serde_json::from_value(read_json(&bridge(&vault).join(format!("requests/{}.json", request.id)))).unwrap();
    assert_eq!(saved, request);
    assert_eq!(fs::read(vault.join("Tasks/task.md")).unwrap(), before);
    // Each explicit call is a deliberate retry; receipt deduplication is per request ID.
    assert_ne!(notes.request_completion(&link).unwrap().id, request.id);
}

#[test]
fn fingerprint_matches_the_plugin() {
    // sha256 of the compact JSON array, as JSON.stringify produces it.
    assert_eq!(digest(&[URL.into(), URL2.into()]), "b31b2186802fd46f54480c60f1bac881ed06486050bb4336028576a246ae6da8");
}

#[test]
fn stale_completion_rejected() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    let old = notes.link("Tasks/task.md", &[URL]).unwrap();
    notes.link("Tasks/task.md", &[URL2]).unwrap();
    fails(notes.request_completion(&old), "changed");
    assert!(!bridge(&vault).join("requests").exists());
}

#[test]
fn invalid_paths_rejected() {
    let (_dir, vault) = vault();
    for path in [
        "../outside.md",
        "/tmp/task.md",
        "Tasks/../task.md",
        "Tasks//task.md",
        "./Tasks/task.md",
        "Tasks\\task.md",
        "C:/task.md",
        ".obsidian/task.md",
        "Tasks/.hidden.md",
        "Tasks/task.txt",
        "Tasks/task.md\n",
        "",
    ] {
        assert!(Notes::new(&vault).unwrap().link(path, &[URL]).is_err(), "{path:?}");
    }
}

#[test]
fn invalid_issue_sets_rejected() {
    let (_dir, vault) = vault();
    let empty: [&str; 0] = [];
    assert!(Notes::new(&vault).unwrap().link("Tasks/task.md", &empty).is_err());
    for url in ["https://evil.example/issue/1", "https://github.com/o/r/pull/1", ""] {
        assert!(Notes::new(&vault).unwrap().link("Tasks/task.md", &[url]).is_err(), "{url}");
    }
}

#[test]
fn frontmatter_must_be_safe_task_metadata() {
    for text in [
        "# Not a task\n",
        "---\ntype: memo\n---\n",
        "---\ntype: task\n",
        "---\n---\n",
        "---\ntype: task\nnotion_managed: true\n---\n",
        "---\ntype: task\nnotion_page_id: bad\n---\n",
        "---\ntype: !!python/object/apply:os.system ['false']\n---\n",
        "---\ntype: !!str task\n---\n",
        "---\ntype: task\na: &a [1]\nb: *a\n---\n",
    ] {
        let (_dir, vault) = vault();
        fs::write(vault.join("Tasks/task.md"), text).unwrap();
        assert!(Notes::new(&vault).unwrap().link("Tasks/task.md", &[URL]).is_err(), "{text:?}");
    }
}

#[test]
fn frontmatter_accepts_bom_and_crlf() {
    let (_dir, vault) = vault();
    fs::write(vault.join("Tasks/task.md"), "\u{feff}---\r\ntype: task\r\n---\r\nBody\r\n").unwrap();
    Notes::new(&vault).unwrap().link("Tasks/task.md", &[URL]).unwrap();
}

#[test]
fn symlinks_rejected() {
    for target in ["note", "parent", "bridge", "registry", "requests", "lock"] {
        let (_dir, vault) = vault();
        let outside_dir = TempDir::new().unwrap();
        let outside = outside_dir.path();
        fs::write(outside.join("task.md"), "---\ntype: task\n---\n").unwrap();
        let notes = Notes::new(&vault).unwrap();
        match target {
            "note" => {
                fs::remove_file(vault.join("Tasks/task.md")).unwrap();
                symlink(outside.join("task.md"), vault.join("Tasks/task.md")).unwrap();
            }
            "parent" => {
                fs::remove_dir_all(vault.join("Tasks")).unwrap();
                symlink(outside, vault.join("Tasks")).unwrap();
            }
            "bridge" => symlink(outside, bridge(&vault)).unwrap(),
            _ => {
                let link = notes.link("Tasks/task.md", &[URL]).unwrap();
                let path = bridge(&vault).join(if target == "registry" { "links.json" } else { target });
                let _ = fs::remove_file(&path);
                symlink(if target == "registry" { outside.join("missing") } else { outside.to_path_buf() }, &path)
                    .unwrap();
                fails(notes.request_completion(&link), "symlink");
                continue;
            }
        }
        fails(notes.link("Tasks/task.md", &[URL]), "symlink");
    }
}

#[test]
fn parallel_updates_do_not_lose_associations() {
    let (_dir, vault) = vault();
    for index in 0..12 {
        fs::write(vault.join(format!("Tasks/{index}.md")), "---\ntype: task\n---\n").unwrap();
    }
    let results: Vec<String> = thread::scope(|scope| {
        let handles: Vec<_> = (0..12)
            .map(|index| {
                let vault = &vault;
                scope.spawn(move || Notes::new(vault).unwrap().link(&format!("Tasks/{index}.md"), &[URL]).unwrap().id)
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect()
    });
    let mut stored: Vec<String> = Notes::new(&vault).unwrap().links().unwrap().into_iter().map(|l| l.id).collect();
    let mut results = results;
    stored.sort();
    results.sort();
    assert_eq!(stored, results);
    let leftovers = fs::read_dir(bridge(&vault))
        .unwrap()
        .filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "tmp"));
    assert_eq!(leftovers.count(), 0);
}

#[test]
fn corrupt_registry_is_not_overwritten() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    notes.link("Tasks/task.md", &[URL]).unwrap();
    let path = bridge(&vault).join("links.json");
    for corrupt in
        [r#"{"schemaVersion": 99, "links": []}"#, r#"{"schemaVersion": 1, "links": [{"id": "x"}]}"#, "not json"]
    {
        fs::write(&path, corrupt).unwrap();
        assert!(notes.link("Tasks/task.md", &[URL2]).is_err(), "{corrupt}");
        assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
    }
}

#[test]
fn path_identity_cannot_be_reassigned_silently() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    notes.link("Tasks/task.md", &[URL]).unwrap();
    fs::write(vault.join("Tasks/task.md"), format!("---\ntype: task\nnotion_page_id: {NOTION_ID}\n---\n")).unwrap();
    fails(notes.link("Tasks/task.md", &[URL2]), "identity changed");
}

#[test]
fn unknown_vault_rejected() {
    let dir = TempDir::new().unwrap();
    assert!(Notes::new(&dir.path().join("missing")).is_err());
}

#[test]
fn add_unions_and_repeat_adds_preserve_identity() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    let before = fs::read(vault.join("Tasks/task.md")).unwrap();
    let first = notes.add("Tasks/task.md", &[URL2]).unwrap();
    let added = notes.add("Tasks/task.md", &[URL, "https://github.com/EXAMPLE/REPO/issues/2"]).unwrap();
    assert_eq!(added.id, first.id);
    assert_eq!(added.issue_urls, [URL, URL2]);
    assert_eq!(notes.add("Tasks/task.md", &[URL]).unwrap(), added);
    assert_eq!(notes.link("Tasks/task.md", &[URL]).unwrap().issue_urls, [URL], "link still replaces the whole set");
    assert_eq!(fs::read(vault.join("Tasks/task.md")).unwrap(), before);
}

#[test]
fn add_uses_canonical_notion_identity_after_rename() {
    let (_dir, vault) = vault();
    let compact = NOTION_ID.replace('-', "").to_uppercase();
    fs::write(vault.join("Tasks/task.md"), format!("---\ntype: task\nnotion_page_id: {compact}\n---\n")).unwrap();
    let notes = Notes::new(&vault).unwrap();
    let first = notes.add("Tasks/task.md", &[URL]).unwrap();
    fs::rename(vault.join("Tasks/task.md"), vault.join("Tasks/renamed.md")).unwrap();
    fs::write(vault.join("Tasks/renamed.md"), format!("---\ntype: task\nnotion_page_id: {NOTION_ID}\n---\n")).unwrap();
    let added = notes.add("Tasks/renamed.md", &[URL2]).unwrap();
    assert_eq!(added.id, first.id);
    assert_eq!(added.note_path, "Tasks/renamed.md");
    assert_eq!(added.issue_urls, [URL, URL2]);
    assert_eq!(added.notion_page_id, first.notion_page_id);
    assert_eq!(notes.add("Tasks/renamed.md", &[URL2]).unwrap(), added);
    assert_eq!(notes.links().unwrap(), [added]);
}

#[test]
fn add_rejects_identity_change() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    let first = notes.add("Tasks/task.md", &[URL]).unwrap();
    fs::write(vault.join("Tasks/task.md"), format!("---\ntype: task\nnotion_page_id: {NOTION_ID}\n---\n")).unwrap();
    fails(notes.add("Tasks/task.md", &[URL2]), "identity changed");
    assert_eq!(notes.links().unwrap(), [first]);
}

#[test]
fn parallel_adds_do_not_lose_issues() {
    let (_dir, vault) = vault();
    let urls: Vec<String> = (1..=12).map(|i| format!("https://github.com/example/repo/issues/{i}")).collect();
    let ids: Vec<String> = thread::scope(|scope| {
        let handles: Vec<_> = urls
            .iter()
            .map(|url| {
                let vault = &vault;
                scope.spawn(move || Notes::new(vault).unwrap().add("Tasks/task.md", &[url]).unwrap().id)
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect()
    });
    let links = Notes::new(&vault).unwrap().links().unwrap();
    assert_eq!(links.len(), 1);
    let mut sorted = urls.clone();
    sorted.sort();
    assert_eq!(links[0].issue_urls, sorted);
    assert!(ids.iter().all(|id| *id == links[0].id));
}

fn write_receipt(vault: &Path, request: &CompletionRequest, status: &str) -> Value {
    let directory = bridge(vault).join("receipts");
    fs::create_dir_all(&directory).unwrap();
    let receipt = json!({
        "schemaVersion": 1, "requestId": request.id, "linkId": request.link_id,
        "issueFingerprint": request.issue_fingerprint, "status": status,
        "recordedAt": Utc::now().to_rfc3339(), "notionConfirmed": false,
    });
    fs::write(directory.join(format!("{}.json", request.id)), receipt.to_string()).unwrap();
    receipt
}

fn age_request(vault: &Path, request: CompletionRequest, days: i64) -> CompletionRequest {
    let request = CompletionRequest { requested_at: (Utc::now() - TimeDelta::days(days)).to_rfc3339(), ..request };
    let path = bridge(vault).join(format!("requests/{}.json", request.id));
    fs::write(path, serde_json::to_string(&request).unwrap()).unwrap();
    request
}

#[test]
fn completion_state_none_pending_and_exact_issue_set() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    let link = notes.link("Tasks/task.md", &[URL]).unwrap();
    assert_eq!(notes.completion_state(&link).unwrap(), None);
    let request = notes.request_completion(&link).unwrap();
    let state = notes.completion_state(&link).unwrap().unwrap();
    assert_eq!(state.status, Status::Pending);
    assert_eq!(state.request_id, request.id);
    assert_eq!(state.requested_at, request.requested_at);
    assert_eq!(state.issue_fingerprint, request.issue_fingerprint);
    assert_eq!(state.receipt, None);
    let updated = notes.add("Tasks/task.md", &[URL2]).unwrap();
    assert_eq!(notes.completion_state(&updated).unwrap(), None);
    fails(notes.completion_state(&link), "changed");
}

#[test]
fn completion_state_returns_latest_receipt() {
    let statuses = [
        ("processing", Status::Processing),
        ("local-accepted", Status::LocalAccepted),
        ("already-done", Status::AlreadyDone),
        ("failed", Status::Failed),
        ("api-unavailable", Status::ApiUnavailable),
        ("stale", Status::Stale),
        ("rolled-back", Status::RolledBack),
        ("interrupted", Status::Interrupted),
    ];
    for (name, status) in statuses {
        let (_dir, vault) = vault();
        let notes = Notes::new(&vault).unwrap();
        let link = notes.link("Tasks/task.md", &[URL]).unwrap();
        let older = age_request(&vault, notes.request_completion(&link).unwrap(), 1);
        write_receipt(&vault, &older, "local-accepted");
        let newer = notes.request_completion(&link).unwrap();
        let receipt = write_receipt(&vault, &newer, name);
        let state = notes.completion_state(&link).unwrap().unwrap();
        assert_eq!(state.request_id, newer.id);
        assert_eq!(state.status, status);
        assert_eq!(state.status.as_str(), name);
        assert_eq!(state.receipt, Some(receipt));
    }
}

#[test]
fn completion_state_expires_only_unprocessed_requests() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    let link = notes.link("Tasks/task.md", &[URL]).unwrap();
    let request = age_request(&vault, notes.request_completion(&link).unwrap(), 2);
    let state = notes.completion_state(&link).unwrap().unwrap();
    assert_eq!(state.status, Status::Stale);
    assert_eq!(state.receipt, None);
    write_receipt(&vault, &request, "local-accepted");
    assert_eq!(notes.completion_state(&link).unwrap().unwrap().status, Status::LocalAccepted);
}

#[test]
fn completion_state_checks_receipt_identity_and_status() {
    for (field, value) in
        [("issueFingerprint", json!("different")), ("status", json!("pending")), ("status", json!("done"))]
    {
        let (_dir, vault) = vault();
        let notes = Notes::new(&vault).unwrap();
        let link = notes.link("Tasks/task.md", &[URL]).unwrap();
        let request = notes.request_completion(&link).unwrap();
        let mut receipt = write_receipt(&vault, &request, "local-accepted");
        receipt[field] = value;
        fs::write(bridge(&vault).join(format!("receipts/{}.json", request.id)), receipt.to_string()).unwrap();
        fails(notes.completion_state(&link), "receipt identity");
    }
}

#[test]
fn completion_state_rejects_receipt_symlink() {
    let (_dir, vault) = vault();
    let notes = Notes::new(&vault).unwrap();
    let link = notes.link("Tasks/task.md", &[URL]).unwrap();
    notes.request_completion(&link).unwrap();
    let outside = TempDir::new().unwrap();
    symlink(outside.path(), bridge(&vault).join("receipts")).unwrap();
    fails(notes.completion_state(&link), "symlink");
}
