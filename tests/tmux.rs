//! Pane discovery fixtures plus an optional private-server smoke test. Never use a user's server.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;

use github_orchestrator::process::{Cmd, Runner, System, which};
use github_orchestrator::tmux::Tmux;
use github_orchestrator::{Error, Result};
use tempfile::TempDir;

struct Row<'a> {
    id: &'a str,
    session_id: &'a str,
    window_id: &'a str,
    dead: &'a str,
    session: &'a str,
    window: &'a str,
    path: &'a str,
    repo: &'a str,
    issue: &'a str,
}

impl Default for Row<'_> {
    fn default() -> Self {
        Self {
            id: "%1",
            session_id: "$0",
            window_id: "@1",
            dead: "0",
            session: "agents",
            window: "#42: task",
            path: "/does-not-exist/gho-tmux-fixture",
            repo: "example/repo",
            issue: "42",
        }
    }
}

fn rows(rows: &[Row<'_>]) -> String {
    rows.iter()
        .map(|row| {
            format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                row.id, row.session_id, row.window_id, row.dead, row.session, row.window, row.path, row.repo, row.issue
            )
        })
        .collect()
}

struct Fixture {
    calls: RefCell<Vec<Cmd>>,
    reads: RefCell<VecDeque<Result<String>>>,
    selection_error: bool,
}

impl Fixture {
    fn new(output: String) -> Self {
        Self { calls: RefCell::new(Vec::new()), reads: RefCell::new([Ok(output)].into()), selection_error: false }
    }

    fn selections(&self) -> Vec<Vec<String>> {
        self.calls.borrow().iter().filter(|cmd| cmd.argv[2] != "list-panes").map(|cmd| cmd.argv.clone()).collect()
    }
}

impl Runner for Fixture {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        assert_eq!(&cmd.argv[..2], ["tmux", "-N"]);
        assert_eq!(cmd.timeout.as_secs(), 5);
        self.calls.borrow_mut().push(cmd.clone());
        match cmd.argv[2].as_str() {
            "list-panes" => {
                assert_eq!(cmd.argv.len(), 6);
                assert!(["-a", "-s"].contains(&cmd.argv[3].as_str()));
                assert_eq!(cmd.argv[4], "-F");
                self.reads.borrow_mut().pop_front().expect("unexpected extra discovery subprocess")
            }
            "select-window" | "select-pane" if self.selection_error => Err(Error::msg("pane disappeared")),
            "select-window" | "select-pane" => Ok(String::new()),
            _ => panic!("unexpected command: {:?}", cmd.argv),
        }
    }
}

#[test]
fn batch_discovery_runs_once_and_serializes_display_names() {
    let fixture = Fixture::new(rows(&[Row::default()]));
    let snapshot = Tmux::new(&fixture, None).snapshot().unwrap();
    for _ in 0..100 {
        let panes = snapshot.panes("example/repo", None, 42);
        assert_eq!(panes.len(), 1);
        assert_eq!(
            serde_json::to_value(&panes[0]).unwrap(),
            serde_json::json!({"id": "%1", "session": "agents", "window": "#42: task"})
        );
        assert!(snapshot.panes("other/repo", None, 42).is_empty());
    }
    assert_eq!(fixture.calls.borrow().len(), 1);
}

#[test]
fn default_scope_uses_the_inherited_session_or_lists_the_default_server() {
    let fixture = Fixture::new(String::new());
    Tmux::new(&fixture, None).snapshot().unwrap();
    let inherited = std::env::var_os("TMUX").is_some_and(|value| !value.is_empty());
    assert_eq!(fixture.calls.borrow()[0].argv[3], if inherited { "-s" } else { "-a" });
}

#[test]
fn tags_match_both_repo_and_issue_not_the_window_title() {
    let fixture = Fixture::new(rows(&[
        Row { id: "%1", repo: "other/repo", ..Row::default() },
        Row { id: "%2", issue: "43", ..Row::default() },
        Row { id: "%3", repo: "EXAMPLE/REPO", window: "arbitrary title", ..Row::default() },
        Row { id: "%4", issue: "042", ..Row::default() },
        Row { id: "%5", issue: "", ..Row::default() },
    ]));
    let panes = Tmux::new(&fixture, None).panes("example/repo", None, 42).unwrap();
    assert_eq!(panes.iter().map(|pane| pane.id.as_str()).collect::<Vec<_>>(), ["%3"]);
}

#[test]
fn multiple_tagged_panes_are_preserved_and_can_each_be_focused() {
    let output = rows(&[
        Row { id: "%2", window_id: "@9", ..Row::default() },
        Row { id: "%1", window_id: "@8", ..Row::default() },
    ]);
    let fixture = Fixture::new(output.clone());
    fixture.reads.borrow_mut().extend([Ok(output.clone()), Ok(output)]);
    let tmux = Tmux::new(&fixture, None);
    assert_eq!(tmux.panes("example/repo", None, 42).unwrap().len(), 2);
    tmux.focus("example/repo", None, 42, "%1").unwrap();
    tmux.focus("example/repo", None, 42, "%2").unwrap();
    assert_eq!(
        fixture.selections(),
        [
            vec!["tmux", "-N", "select-window", "-t", "$0:@8"],
            vec!["tmux", "-N", "select-pane", "-t", "%1"],
            vec!["tmux", "-N", "select-window", "-t", "$0:@9"],
            vec!["tmux", "-N", "select-pane", "-t", "%2"],
        ]
    );
}

#[test]
fn missing_or_stale_panes_cannot_be_focused() {
    for changed in [
        String::new(),
        rows(&[Row { id: "%2", ..Row::default() }]),
        rows(&[Row { repo: "other/repo", ..Row::default() }]),
        rows(&[Row { issue: "43", ..Row::default() }]),
        rows(&[Row { dead: "1", ..Row::default() }]),
    ] {
        let fixture = Fixture::new(rows(&[Row::default()]));
        fixture.reads.borrow_mut().push_back(Ok(changed));
        let tmux = Tmux::new(&fixture, None);
        assert_eq!(tmux.panes("example/repo", None, 42).unwrap().len(), 1);
        assert!(tmux.focus("example/repo", None, 42, "%1").is_err());
        assert!(fixture.selections().is_empty());
        assert_eq!(fixture.calls.borrow().len(), 2, "focus must read live membership again");
    }
}

#[test]
fn disappearance_during_selection_is_an_error_not_success() {
    let mut fixture = Fixture::new(rows(&[Row::default()]));
    fixture.selection_error = true;
    assert!(Tmux::new(&fixture, None).focus("example/repo", None, 42, "%1").is_err());
    assert_eq!(fixture.selections().len(), 1, "stop when selecting the window fails");
}

#[test]
fn session_restriction_is_exact_and_focus_stays_in_that_session() {
    let output = rows(&[
        Row { id: "%1", session: "agents-extra", ..Row::default() },
        Row { id: "%2", session: "agents", session_id: "$7", window_id: "@4", ..Row::default() },
    ]);
    let fixture = Fixture::new(output.clone());
    fixture.reads.borrow_mut().extend([Ok(output.clone()), Ok(output)]);
    let tmux = Tmux::new(&fixture, Some("agents"));
    let panes = tmux.panes("example/repo", None, 42).unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].id, "%2");
    assert!(tmux.focus("example/repo", None, 42, "%1").is_err());
    tmux.focus("example/repo", None, 42, "%2").unwrap();
    assert_eq!(fixture.calls.borrow()[0].argv[3], "-a");
    assert_eq!(fixture.selections()[0], ["tmux", "-N", "select-window", "-t", "$7:@4"]);
}

#[test]
fn missing_session_and_fuzzy_session_names_are_errors() {
    for session in ["missing", "agent", "agents*", "=agents", "$0", ""] {
        let fixture = Fixture::new(rows(&[Row::default()]));
        assert!(Tmux::new(&fixture, Some(session)).snapshot().is_err(), "{session:?}");
    }
}

#[test]
fn dead_panes_are_neither_discovered_nor_focused() {
    let output = rows(&[Row { id: "%1", dead: "1", ..Row::default() }, Row { id: "%2", dead: "0", ..Row::default() }]);
    let fixture = Fixture::new(output.clone());
    fixture.reads.borrow_mut().push_back(Ok(output));
    let tmux = Tmux::new(&fixture, None);
    assert_eq!(tmux.panes("example/repo", None, 42).unwrap()[0].id, "%2");
    assert!(tmux.focus("example/repo", None, 42, "%1").is_err());
    assert!(fixture.selections().is_empty());
}

#[test]
fn untagged_fallback_requires_one_exact_canonical_worktree_root() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("worktree");
    let subdir = root.join("src");
    let collision = dir.path().join("worktree-other");
    fs::create_dir_all(&subdir).unwrap();
    fs::create_dir(&collision).unwrap();
    let alias = dir.path().join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    let root = root.to_str().unwrap();
    let fixture = Fixture::new(rows(&[
        Row { id: "%1", repo: "", issue: "", path: alias.to_str().unwrap(), ..Row::default() },
        Row { id: "%2", repo: "", issue: "", path: subdir.to_str().unwrap(), ..Row::default() },
        Row { id: "%3", repo: "", issue: "", path: collision.to_str().unwrap(), ..Row::default() },
    ]));
    let snapshot = Tmux::new(&fixture, None).snapshot().unwrap();
    let panes = snapshot.panes("example/repo", Some(root), 42);
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].id, "%1");
    assert!(snapshot.panes("example/repo", None, 42).is_empty());
    assert!(snapshot.panes("example/repo", Some("/nonexistent/worktree"), 42).is_empty());
    assert!(snapshot.panes("example/repo", Some("."), 42).is_empty());
}

#[test]
fn untagged_subdirectories_and_path_prefix_collisions_are_not_matches() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("worktree");
    let subdir = root.join("src");
    let collision = dir.path().join("worktree-other");
    fs::create_dir_all(&subdir).unwrap();
    fs::create_dir(&collision).unwrap();
    for path in [&subdir, &collision] {
        let fixture =
            Fixture::new(rows(&[Row { repo: "", issue: "", path: path.to_str().unwrap(), ..Row::default() }]));
        assert!(Tmux::new(&fixture, None).panes("example/repo", root.to_str(), 42).unwrap().is_empty());
    }
}

#[test]
fn ambiguous_untagged_panes_are_not_offered_even_if_one_was_previously_visible() {
    let root = TempDir::new().unwrap();
    let path = root.path().to_str().unwrap();
    let fixture = Fixture::new(rows(&[Row { repo: "", issue: "", path, ..Row::default() }]));
    fixture.reads.borrow_mut().push_back(Ok(rows(&[
        Row { id: "%1", repo: "", issue: "", path, ..Row::default() },
        Row { id: "%2", repo: "", issue: "", path, ..Row::default() },
    ])));
    let tmux = Tmux::new(&fixture, None);
    assert_eq!(tmux.panes("example/repo", Some(path), 42).unwrap().len(), 1);
    assert!(tmux.focus("example/repo", Some(path), 42, "%1").is_err());
    assert!(fixture.selections().is_empty());
}

#[test]
fn conflicting_or_partial_tags_never_fall_back_to_worktree_path() {
    let root = TempDir::new().unwrap();
    let path = root.path().to_str().unwrap();
    for (repo, issue) in [("other/repo", "42"), ("example/repo", "43"), ("example/repo", ""), ("", "42")] {
        let fixture = Fixture::new(rows(&[Row { repo, issue, path, ..Row::default() }]));
        assert!(Tmux::new(&fixture, None).panes("example/repo", Some(path), 42).unwrap().is_empty());
    }
}

#[test]
fn matching_tags_take_precedence_over_untagged_shells() {
    let root = TempDir::new().unwrap();
    let path = root.path().to_str().unwrap();
    let fixture = Fixture::new(rows(&[
        Row { id: "%1", ..Row::default() },
        Row { id: "%2", repo: "", issue: "", path, ..Row::default() },
    ]));
    let panes = Tmux::new(&fixture, None).panes("example/repo", Some(path), 42).unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].id, "%1");
}

#[test]
fn dead_untagged_panes_do_not_make_the_fallback_ambiguous() {
    let root = TempDir::new().unwrap();
    let path = root.path().to_str().unwrap();
    let fixture = Fixture::new(rows(&[
        Row { id: "%1", repo: "", issue: "", path, ..Row::default() },
        Row { id: "%2", repo: "", issue: "", path, dead: "1", ..Row::default() },
    ]));
    assert_eq!(Tmux::new(&fixture, None).panes("example/repo", Some(path), 42).unwrap().len(), 1);
}

#[test]
fn changed_working_directory_invalidates_untagged_focus() {
    let root = TempDir::new().unwrap();
    let elsewhere = TempDir::new().unwrap();
    let path = root.path().to_str().unwrap();
    let fixture = Fixture::new(rows(&[Row { repo: "", issue: "", path, ..Row::default() }]));
    fixture.reads.borrow_mut().push_back(Ok(rows(&[Row {
        repo: "",
        issue: "",
        path: elsewhere.path().to_str().unwrap(),
        ..Row::default()
    }])));
    let tmux = Tmux::new(&fixture, None);
    assert_eq!(tmux.panes("example/repo", Some(path), 42).unwrap().len(), 1);
    assert!(tmux.focus("example/repo", Some(path), 42, "%1").is_err());
    assert!(fixture.selections().is_empty());
}

#[test]
fn linked_windows_offer_each_tagged_pane_once_without_a_session_restriction() {
    let output = rows(&[
        Row { session: "other", session_id: "$0", ..Row::default() },
        Row { session: "agents", session_id: "$1", ..Row::default() },
    ]);
    let fixture = Fixture::new(output.clone());
    fixture.reads.borrow_mut().push_back(Ok(output));
    let tmux = Tmux::new(&fixture, None);
    let panes = tmux.panes("example/repo", None, 42).unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].session, "other");
    tmux.focus("example/repo", None, 42, &panes[0].id).unwrap();
    assert_eq!(fixture.selections()[0], ["tmux", "-N", "select-window", "-t", "$0:@1"]);
}

#[test]
fn linked_windows_respect_explicit_session_membership() {
    let fixture = Fixture::new(rows(&[
        Row { session: "other", session_id: "$0", ..Row::default() },
        Row { session: "agents", session_id: "$1", ..Row::default() },
    ]));
    Tmux::new(&fixture, Some("agents")).focus("example/repo", None, 42, "%1").unwrap();
    assert_eq!(fixture.selections()[0], ["tmux", "-N", "select-window", "-t", "$1:@1"]);
}

#[test]
fn pane_id_injection_is_rejected_before_any_subprocess() {
    let fixture = Fixture::new(String::new());
    for pane in ["", "%", "1", "-t", "%1;", "%1 ; kill-server", "$(touch /tmp/gho-injection)", "#{pane_id}", "%1\n"] {
        assert!(Tmux::new(&fixture, None).focus("example/repo", None, 42, pane).is_err(), "{pane:?}");
    }
    assert!(fixture.calls.borrow().is_empty());
}

#[test]
fn untrusted_session_repo_and_window_names_never_become_command_arguments() {
    let injected = "agents; run-shell 'touch /tmp/gho-injection'";
    let repo = "$(touch /tmp/gho-injection)";
    let fixture = Fixture::new(rows(&[Row { session: injected, window: injected, repo, ..Row::default() }]));
    Tmux::new(&fixture, Some(injected)).focus(repo, None, 42, "%1").unwrap();
    let calls = fixture.calls.borrow();
    assert!(calls.iter().all(|cmd| cmd.argv.iter().all(|arg| !arg.contains(injected) && !arg.contains(repo))));
    let format = &calls[0].argv[5];
    assert!(format.contains("#{m/r:[[:cntrl:]],"), "control characters must not create forged records");
    assert!(!format.contains("#{E:") && !format.contains("#("), "never evaluate option values again");
}

#[test]
fn malformed_server_data_fails_closed() {
    for output in [
        "not a pane\n".into(),
        rows(&[Row { id: "%1;", ..Row::default() }]),
        rows(&[Row { session_id: "$0;", ..Row::default() }]),
        rows(&[Row { window_id: "@1;", ..Row::default() }]),
        rows(&[Row { dead: "unknown", ..Row::default() }]),
        rows(&[Row { window: "bad\twindow", ..Row::default() }]),
        rows(&[Row { window: "bad\rwindow", ..Row::default() }]),
        rows(&[Row { repo: "bad\nrepo", ..Row::default() }]),
    ] {
        let fixture = Fixture::new(output);
        assert!(Tmux::new(&fixture, None).focus("example/repo", None, 42, "%1").is_err());
        assert!(fixture.selections().is_empty());
    }
}

#[test]
fn absent_executable_server_or_permission_is_reported_to_the_caller() {
    for message in ["Required executable not found: tmux", "no server running", "permission denied"] {
        let fixture = Fixture::new(String::new());
        fixture.reads.borrow_mut()[0] = Err(Error::msg(message));
        let error = Tmux::new(&fixture, None).snapshot().unwrap_err();
        assert!(error.to_string().contains(message));
    }
}

struct PrivateServer {
    socket: PathBuf,
    _dir: TempDir,
}

impl PrivateServer {
    fn invoke(&self, args: &[&str]) -> Result<String> {
        System.run(
            &Cmd::new(
                ["tmux", "-S", self.socket.to_str().unwrap(), "-f", "/dev/null"]
                    .into_iter()
                    .chain(args.iter().copied()),
            )
            .env("TMUX", "")
            .env("TMUX_PANE", "")
            .timeout(5),
        )
    }
}

impl Runner for PrivateServer {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        assert_eq!(cmd.argv[0], "tmux");
        self.invoke(&cmd.argv[1..].iter().map(String::as_str).collect::<Vec<_>>())
    }
}

impl Drop for PrivateServer {
    fn drop(&mut self) {
        // This socket exists only in this test's temporary directory, even when startup failed.
        let _ = self.invoke(&["-N", "kill-server"]);
    }
}

#[test]
fn isolated_tmux_server_smoke_test() {
    if which("tmux").is_none() {
        eprintln!("skipped: private tmux smoke test requires tmux");
        return;
    }
    let dir = TempDir::new().unwrap();
    let server = PrivateServer { socket: dir.path().join("socket"), _dir: dir };
    if let Err(error) = server.invoke(&["new-session", "-d", "-s", "agents", "sleep", "60"]) {
        let message = error.to_string();
        if message.contains("Operation not permitted") || message.contains("Permission denied") {
            eprintln!("skipped: sandbox cannot create a private tmux server: {message}");
            return;
        }
        panic!("cannot start private tmux server: {message}");
    }
    let pane = server
        .invoke(&["new-window", "-d", "-t", "agents", "-P", "-F", "#{pane_id}", "-n", "implementer", "sleep", "60"])
        .unwrap()
        .trim()
        .to_string();
    server.invoke(&["set-option", "-p", "-t", &pane, "@gho_repo", "example/repo"]).unwrap();
    server.invoke(&["set-option", "-p", "-t", &pane, "@gho_issue", "42"]).unwrap();
    let tmux = Tmux::new(&server, Some("agents"));
    let panes = tmux.panes("example/repo", None, 42).unwrap();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].id, pane);
    assert_eq!(panes[0].window, "implementer");
    assert!(tmux.panes("other/repo", None, 42).unwrap().is_empty());
    tmux.focus("example/repo", None, 42, &pane).unwrap();
    assert_eq!(server.invoke(&["display-message", "-p", "-t", "agents", "#{pane_id}"]).unwrap().trim(), pane);

    // User-option values are data, not a second format expansion or a shell command.
    let marker = server._dir.path().join("must-not-exist");
    let attack = format!("#(touch {})#{{pane_id}}", marker.display());
    server.invoke(&["set-option", "-p", "-t", &pane, "@gho_repo", &attack]).unwrap();
    assert_eq!(tmux.panes(&attack, None, 42).unwrap().len(), 1);
    assert!(!marker.exists());

    // Control characters in user options must omit a record, not introduce fake pane records.
    server.invoke(&["set-option", "-p", "-t", &pane, "@gho_repo", "example/repo\nforged\tdata"]).unwrap();
    assert!(tmux.panes("example/repo", None, 42).unwrap().is_empty());
    server.invoke(&["set-option", "-p", "-t", &pane, "@gho_repo", "example/repo"]).unwrap();
    server.invoke(&["kill-pane", "-t", &pane]).unwrap();
    assert!(tmux.focus("example/repo", None, 42, &pane).is_err());
}
