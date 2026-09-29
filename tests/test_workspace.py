"""Real Git/Worktrunk tests use disposable repositories, never a developer checkout."""

import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from github_orchestrator.config import Config
from github_orchestrator.domain import OrchestratorError, Run
from github_orchestrator.sandbox import Sandbox
from github_orchestrator.workspace import Workspace, github_remote_repo


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


@pytest.fixture
def repository():
    # Isara only discovers overrides below HOME; fixture data is deleted after the test.
    with tempfile.TemporaryDirectory(prefix="gho-test-", dir=Path.home()) as temporary:
        root = Path(temporary)
        source = root / "source"
        source.mkdir()
        git(source, "init", "-b", "main")
        git(source, "config", "user.name", "Test User")
        git(source, "config", "user.email", "test@example.invalid")
        git(source, "config", "commit.gpgsign", "false")
        git(source, "remote", "add", "origin", "https://github.com/example/mono.git")
        (source / "README.md").write_text("fixture\n")
        git(source, "add", ".")
        git(source, "-c", "core.hooksPath=/dev/null", "commit", "-m", "initial")
        isara = Path(os.environ.get("GHO_ISARA_CHECKOUT", str(root / "isara")))
        config = Config("example/mono", "rowantran", "PVT_example", "https://github.com/users/rowantran/projects/1",
                        source, root / "state", root / "work", "test-model",
                        isara / "src/project/pi_provider/isara_provider.ts", isara,
                        context_files=("README.md",))
        config.state_dir.mkdir()
        yield config


def make_run(config, workspace, name="one"):
    base = workspace.git("rev-parse", "HEAD")
    return Run(name, "https://github.com/example/mono/issues/1", "hash", "preparing",
               f"rowantran/agents/{name}", str(config.tasks_dir / name), base)


@pytest.mark.parametrize("url", ["https://github.com/example/mono.git", "https://github.com/example/mono",
                                     "git@github.com:example/mono.git"])
def test_remote_canonicalization(url):
    assert github_remote_repo(url) == "example/mono"


@pytest.mark.parametrize("url", ["https://token@github.com/example/mono.git", "https://github.com.evil/owner/repo",
                                     "/tmp/repo", "ssh://evil/path"])
def test_remote_rejects_credentials_and_other_hosts(url):
    assert github_remote_repo(url) is None


def test_clone_does_not_touch_original_checkout(repository):
    workspace = Workspace(repository)
    before = git(repository.checkout, "status", "--porcelain")
    workspace.ensure_clone()
    assert workspace.git("remote", "get-url", "origin") == "https://github.com/example/mono.git"
    assert not (repository.clone / "README.md").exists()  # no main checkout for agents to edit
    assert not (repository.clone / ".git/objects/info/alternates").exists()
    assert git(repository.checkout, "status", "--porcelain") == before


@pytest.mark.skipif(shutil.which("wt") is None, reason="Worktrunk integration requires wt")
def test_worktrunk_create_commit_and_safe_cleanup(repository):
    workspace = Workspace(repository)
    workspace.ensure_clone()
    run = make_run(repository, workspace)
    workspace.create(run)
    path = Path(run.worktree)
    assert (path / "README.md").read_text() == "fixture\n"
    (path / "new.txt").write_text("implementation\n")
    (path / ".gho").mkdir()
    (path / ".gho/result.json").write_text("{}")
    assert workspace.changed_files(run) == ["new.txt"]
    with pytest.raises(OrchestratorError, match="merged"):
        workspace.cleanup(run)
    commit = workspace.commit(run, "Implement fixture")
    assert commit != run.base_commit
    assert not workspace.git("ls-tree", "--name-only", "HEAD", "--", ".gho", cwd=path)
    run.commit = commit
    assert workspace.commit(run, "retry") == commit
    run.status = "merged"
    workspace.cleanup(run)
    assert not path.exists()
    assert workspace.git("rev-parse", run.branch) == commit
    assert (repository.checkout / "README.md").read_text() == "fixture\n"


@pytest.mark.skipif(shutil.which("wt") is None, reason="Worktrunk integration requires wt")
def test_worktree_git_hooks_never_execute(repository):
    workspace = Workspace(repository)
    workspace.ensure_clone()
    hook = repository.clone / ".git/hooks/post-checkout"
    marker = repository.workspace_dir / "hook-ran"
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
    hook.chmod(0o755)
    run = make_run(repository, workspace, "hooks")
    workspace.create(run)
    assert not marker.exists()


@pytest.mark.skipif(not os.environ.get("GHO_ISARA_CHECKOUT") or platform.system() != "Darwin",
                    reason="Opt-in actual Isara/Seatbelt test: set GHO_ISARA_CHECKOUT on macOS")
def test_real_isara_policy_confines_worker_without_model_call(repository):
    workspace = Workspace(repository)
    workspace.ensure_clone()
    run = make_run(repository, workspace, "sandbox")
    workspace.create(run)
    path = Path(run.worktree)
    sandbox = Sandbox(repository)
    policy = sandbox.prepare(path)
    assert policy["filesystem"]["allowWrite"] == ["."]
    assert not policy["network"].get("allowMachLookup")
    assert not policy["network"].get("allowUnixSockets")
    settings = path / ".gho/input/resolved-sandbox.json"
    assert json.loads(settings.read_text()) == policy
    # The actual Pi executable can initialize in the sandbox with its isolated home.
    output = sandbox.commands.run(["srt", "--settings", str(settings), "--", str(path / ".gho/bin/pi"), "--version"],
                                   cwd=path, timeout=30)
    assert output.strip() == "0.87.1"
