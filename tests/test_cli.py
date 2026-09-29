import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from test_runner import issue, pr
from test_runner import runner as runner

from github_orchestrator import cli
from github_orchestrator.config import load_config
from github_orchestrator.domain import OrchestratorError, digest


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
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    args = cli.parser().parse_args([
        "init", "--checkout", str(checkout), "--project", project, "--model", "test-model",
        "--isara-checkout", str(tmp_path / "isara"), "--context-file", "README.md",
        "--context-file", "docs/guide.md", "--vault", str(tmp_path / "vault"),
    ])
    cli.init_config(args)
    return args, calls


def test_init_round_trip_private_home_paths_and_no_overwrite(initialized, tmp_path):
    args, calls = initialized
    config = load_config(args.config)
    assert config.repo == "acme/app" and config.owner == "Owner"
    assert config.context_files == ("README.md", "docs/guide.md")
    assert config.state_dir == tmp_path / ".local/state/github-orchestrator/acme--app--owner"
    assert config.workspace_dir == tmp_path / ".local/share/github-orchestrator/acme--app--owner"
    assert config.vault == tmp_path / "vault" and not config.vault.exists()
    assert args.config.stat().st_mode & 0o777 == 0o600
    before = args.config.read_bytes()
    with pytest.raises(OrchestratorError, match="already exists"):
        cli.init_config(args)
    assert args.config.read_bytes() == before and len(calls) == 2
    for changes in ({"state_dir": tmp_path}, {"workspace_dir": tmp_path / "source/work"},
                    {"workspace_dir": config.state_dir / "work"}, {"context_files": ("../secret",)}):
        with pytest.raises(OrchestratorError):
            replace(config, **changes).validate()


@pytest.mark.parametrize("old,new", [
    ("[queue]", "[queue"), ('project_id = "PVT_queue"', "project_id = 7"),
    ('context_files = ["README.md", "docs/guide.md"]', 'context_files = "README.md"'),
    ("max_workers = 2", "max_workers = true"),
])
def test_invalid_config_has_actionable_error(initialized, old, new, capsys):
    args, _ = initialized
    original = args.config.read_text()
    assert old in original
    args.config.write_text(original.replace(old, new))
    with pytest.raises(OrchestratorError, match="config|project_id|context_files|max_workers"):
        load_config(args.config)
    assert cli.main(["--config", str(args.config), "runs"]) == 1
    error = capsys.readouterr().err
    assert "gho:" in error and "Traceback" not in error


@pytest.mark.parametrize("section", ["queue", "worker", "obsidian"])
def test_config_sections_must_be_tables(tmp_path, section, capsys):
    path = tmp_path / "config.toml"
    path.write_text("\n".join(f"{name} = {'[]' if name == section else '{}'}"
                              for name in ("queue", "worker", "obsidian")))
    with pytest.raises(OrchestratorError, match="must be TOML tables"):
        load_config(path)
    assert cli.main(["--config", str(path), "runs"]) == 1
    assert "Traceback" not in capsys.readouterr().err


def test_init_rejects_repo_mismatch_before_creating_config(initialized):
    args, _ = initialized
    args.config = args.config.with_name("other.toml")
    args.repo = "other/repo"
    with pytest.raises(OrchestratorError, match="origin must match"):
        cli.init_config(args)
    assert not args.config.exists()


@pytest.mark.parametrize("argv", [["approve", "1"], ["init", "--model", "m"], ["notes", "link", "task.md"]])
def test_parser_requires_review_and_command_inputs(argv, monkeypatch, tmp_path):
    monkeypatch.setenv("GHO_CONFIG", str(tmp_path / "custom.toml"))
    assert cli.parser().parse_args(["runs"]).config == tmp_path / "custom.toml"
    with pytest.raises(SystemExit) as exc:
        cli.parser().parse_args(argv)
    assert exc.value.code == 2


@pytest.mark.parametrize("tty,answer,yes,allowed", [
    (False, "yes", False, False), (False, "", True, True), (True, "NO", False, False),
    (True, " Yes ", False, True),
])
def test_confirmation_requires_explicit_consent(monkeypatch, tty, answer, yes, allowed):
    monkeypatch.setattr(cli.sys, "stdin", SimpleNamespace(isatty=lambda: tty))
    monkeypatch.setattr("builtins.input", lambda _: answer)
    if allowed:
        cli.confirm("Publish?", yes)
    else:
        with pytest.raises(OrchestratorError, match="--yes|Canceled"):
            cli.confirm("Publish?", yes)


def test_preview_approval_and_revocation_use_canonical_urls(runner, monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_config", lambda _: runner.config)
    monkeypatch.setattr(cli, "Runner", lambda _: runner)
    monkeypatch.setattr(cli.sys, "stdin", SimpleNamespace(isatty=lambda: False))
    assert cli.main(["context", "1"]) == 0
    preview = next((runner.config.state_dir / "previews").iterdir())
    approval = json.loads((preview / "approval.json").read_text())
    fingerprint = approval["fingerprint"]
    assert fingerprint in capsys.readouterr().out
    args = ["approve", "https://github.com/ACME/App/issues/1", "--fingerprint", fingerprint]
    assert cli.main(args) == 1
    assert runner.store.approval(issue().ref.url) is None
    assert "--yes" in capsys.readouterr().err
    assert cli.main([*args, "--yes"]) == 0
    assert runner.store.approval(issue().ref.url)["fingerprint"] == fingerprint
    with runner.store.lock():  # Revocation cannot wait for the dispatcher's execution lock.
        assert cli.main(["revoke", "https://github.com/Acme/APP/issues/1"]) == 0
    assert runner.store.approval(issue().ref.url) is None


def fake_notes(urls, status=None):
    link = {"notePath": "Tasks/task.md", "issueUrls": urls}
    requests = []
    notes = SimpleNamespace(links=lambda: [link], status=status, requests=requests)
    notes.completion_state = lambda _: {"status": notes.status} if notes.status else None

    def request(value):
        requests.append(value)
        notes.status = "pending"
        return {"id": "request-1"}

    notes.request_completion = request
    return notes


@pytest.mark.parametrize("status", [None, "pending", "processing", "local-accepted", "already-done", "failed", "stale"])
@pytest.mark.parametrize("retry", [False, True])
def test_sync_notes_deduplicates_and_requires_explicit_retry(runner, status, retry):
    task = issue(state="CLOSED", state_reason="COMPLETED")
    runner.github.issues[task.ref.key] = task
    runner.store.acknowledge(task.ref.url, digest(task.plan()))
    notes = fake_notes([task.ref.url], status)
    cli.sync_notes(runner, notes, retry=retry)
    expected = status is None or (retry and status in {"failed", "stale"})
    assert len(notes.requests) == int(expected)
    cli.sync_notes(runner, notes, retry=retry)
    assert len(notes.requests) == int(expected)


@pytest.mark.parametrize("reason,evidence,ack,allowed", [
    ("NOT_PLANNED", "merged", True, False), ("DUPLICATE", "merged", True, False),
    ("COMPLETED", "none", False, False), ("COMPLETED", "none", True, True),
    ("COMPLETED", "unmerged", False, False), ("COMPLETED", "wrong-base", False, False),
    ("COMPLETED", "not-integrated", False, False), ("COMPLETED", "merged", False, True),
])
def test_sync_notes_checks_every_issue_with_strict_completion(runner, reason, evidence, ack, allowed, capsys):
    first = issue(state="CLOSED", state_reason="COMPLETED")
    second = issue(2, state="CLOSED", state_reason=reason, pull_requests=() if evidence == "none" else (
        pr(merged=evidence != "unmerged", base="release" if evidence == "wrong-base" else "main", merge_commit="m"),))
    for task in (first, second):
        runner.github.issues[task.ref.key] = task
    runner.store.acknowledge(first.ref.url, digest(first.plan()))
    if ack:
        runner.store.acknowledge(second.ref.url, digest(second.plan()))
    if evidence != "not-integrated":
        runner.workspace.integrated.add("m")
    notes = fake_notes([first.ref.url, second.ref.url], "failed")
    cli.sync_notes(runner, notes, retry=True)
    assert bool(notes.requests) is allowed
    assert ("Waiting:" in capsys.readouterr().out) is not allowed
