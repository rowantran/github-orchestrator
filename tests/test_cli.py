import json
from types import SimpleNamespace

import pytest

from github_orchestrator import cli
from github_orchestrator.config import load_config
from github_orchestrator.domain import OrchestratorError


@pytest.fixture
def initialized(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("GHO_CONFIG", raising=False)
    checkout = tmp_path / "source"
    checkout.mkdir()
    calls = []

    def command(argv, *, cwd=None):
        calls.append(argv)
        if argv == ["git", "remote", "get-url", "origin"]:
            assert cwd == checkout
            return "git@github.com:Acme/App.git\n"
        assert argv == ["gh", "api", "--hostname", "github.com", "user", "--jq", ".login"]
        return "Owner\n"

    project = "https://github.com/users/Owner/projects/1"
    monkeypatch.setattr(cli, "Commands", lambda: SimpleNamespace(run=command))
    monkeypatch.setattr(cli, "GitHub", lambda *args: SimpleNamespace(
        resolve_project=lambda url: {"id": "PVT_queue", "url": url}))
    args = cli.parser().parse_args([
        "init", "--checkout", str(checkout), "--project", project, "--vault", str(tmp_path / "vault"),
    ])
    cli.init_config(args)
    return args, calls


def test_init_round_trip_and_no_overwrite(initialized, tmp_path):
    args, calls = initialized
    config = load_config(args.config)
    assert config.repo == "acme/app" and config.owner == "Owner"
    assert config.checkout == (tmp_path / "source").resolve() and config.base_branch == "main"
    assert config.vault == (tmp_path / "vault").resolve() and not config.vault.exists()
    assert config.branch(42) == "Owner/gh-42"
    before = args.config.read_bytes()
    with pytest.raises(OrchestratorError, match="already exists"):
        cli.init_config(args)
    assert args.config.read_bytes() == before and len(calls) == 2


@pytest.mark.parametrize("old,new", [("[queue]", "[queue"), ('project_id = "PVT_queue"', "project_id = 7"),
                                     ('base_branch = "main"', 'base_branch = "../x"')])
def test_invalid_config_has_actionable_error(initialized, old, new, capsys):
    args, _ = initialized
    original = args.config.read_text()
    assert old in original
    args.config.write_text(original.replace(old, new))
    with pytest.raises(OrchestratorError):
        load_config(args.config)
    assert cli.main(["--config", str(args.config), "ready"]) == 1
    error = capsys.readouterr().err
    assert "gho:" in error and "Traceback" not in error


def test_init_rejects_repo_mismatch_before_creating_config(initialized):
    args, _ = initialized
    args.config = args.config.with_name("other.toml")
    args.repo = "other/repo"
    with pytest.raises(OrchestratorError, match="origin must match"):
        cli.init_config(args)
    assert not args.config.exists()


@pytest.mark.parametrize("argv", [["worktree"], ["init"], ["notes", "link", "task.md"], ["approve", "1"]])
def test_parser_rejects_incomplete_or_removed_commands(argv):
    with pytest.raises(SystemExit) as exc:
        cli.parser().parse_args(argv)
    assert exc.value.code == 2


ITEMS = [
    {"number": 1, "title": "Ready one", "state": "ready", "worktree": None, "blockers": []},
    {"number": 2, "title": "Blocked one", "state": "blocked", "worktree": None, "blockers": [
        {"repo": "acme/app", "number": 1, "done": False, "branch": "Owner/gh-1", "state": "OPEN"}]},
    {"number": 3, "title": "Working", "state": "in_progress", "worktree": "/w/3", "blockers": []},
]


@pytest.fixture
def configured(initialized, monkeypatch):
    args, _ = initialized
    monkeypatch.setattr(cli, "GitHub", lambda *a: SimpleNamespace())
    monkeypatch.setattr(cli, "survey", lambda github, workspace: ITEMS)
    return args.config


def test_ready_lists_only_ready_work_unless_all(configured, capsys):
    assert cli.main(["--config", str(configured), "ready", "--json"]) == 0
    assert [item["number"] for item in json.loads(capsys.readouterr().out)] == [1]
    assert cli.main(["--config", str(configured), "ready", "--all"]) == 0
    out = capsys.readouterr().out
    assert "READY" in out and "BLOCKED" in out and "IN_PROGRESS" in out
    assert "waits on acme/app#1 (branch Owner/gh-1)" in out and "/w/3" in out


def test_worktree_passes_number_and_base(configured, monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(cli.Workspace, "create", lambda self, number, base: seen.append((number, base)) or
                        {"issue": number, "path": "/w"})
    assert cli.main(["--config", str(configured), "worktree", "https://github.com/ACME/app/issues/5",
                     "--base", "Owner/gh-4"]) == 0
    assert seen == [(5, "Owner/gh-4")] and json.loads(capsys.readouterr().out)["path"] == "/w"
    assert cli.main(["--config", str(configured), "worktree", "https://github.com/other/repo/issues/5"]) == 1


@pytest.mark.parametrize("tty,answer,yes,allowed", [
    (False, "yes", False, False), (False, "", True, True), (True, "NO", False, False), (True, " Yes ", False, True),
])
def test_confirmation_requires_explicit_consent(monkeypatch, tty, answer, yes, allowed):
    monkeypatch.setattr(cli.sys, "stdin", SimpleNamespace(isatty=lambda: tty))
    monkeypatch.setattr("builtins.input", lambda _: answer)
    if allowed:
        cli.confirm("Install?", yes)
    else:
        with pytest.raises(OrchestratorError, match="--yes|Canceled"):
            cli.confirm("Install?", yes)


def fake_notes(urls, status=None):
    link = {"notePath": "Tasks/task.md", "issueUrls": urls}
    notes = SimpleNamespace(links=lambda: [link], status=status, requests=[])
    notes.completion_state = lambda _: {"status": notes.status} if notes.status else None

    def request(value):
        notes.requests.append(value)
        notes.status = "pending"
        return {"id": "request-1"}

    notes.request_completion = request
    return notes


def fake_github(reasons):
    return SimpleNamespace(issue=lambda ref: SimpleNamespace(completed=reasons[ref.number] == "COMPLETED"))


@pytest.mark.parametrize("status", [None, "pending", "processing", "local-accepted", "already-done", "failed", "stale"])
@pytest.mark.parametrize("retry", [False, True])
def test_complete_notes_deduplicates_and_requires_explicit_retry(status, retry):
    notes = fake_notes(["https://github.com/acme/app/issues/1"], status)
    for _ in range(2):
        cli.complete_notes(fake_github({1: "COMPLETED"}), notes, retry=retry)
    expected = status is None or (retry and status in {"failed", "stale"})
    assert len(notes.requests) == int(expected)


@pytest.mark.parametrize("second,allowed", [("COMPLETED", True), ("NOT_PLANNED", False), ("DUPLICATE", False),
                                            (None, False)])
def test_complete_notes_requires_every_issue_completed(second, allowed, capsys):
    notes = fake_notes(["https://github.com/acme/app/issues/1", "https://github.com/acme/app/issues/2"])
    cli.complete_notes(fake_github({1: "COMPLETED", 2: second}), notes)
    assert bool(notes.requests) is allowed
    assert ("Waiting:" in capsys.readouterr().out) is not allowed
