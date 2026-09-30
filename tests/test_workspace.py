"""Real Git/Worktrunk tests in disposable repositories, never a developer checkout."""

import shutil
import subprocess
from pathlib import Path

import pytest

from github_orchestrator.config import Config
from github_orchestrator.domain import OrchestratorError
from github_orchestrator.workspace import Workspace, github_remote_repo

needs_wt = pytest.mark.skipif(shutil.which("wt") is None, reason="Worktrunk integration requires wt")


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


def commit(path, name, message):
    (path / name).write_text(message + "\n")
    git(path, "add", name)
    git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
        "commit", "-q", "-m", message)
    return git(path, "rev-parse", "HEAD")


@pytest.fixture
def repository(tmp_path):
    """A checkout whose origin is a local bare repository standing in for GitHub."""
    origin = tmp_path / "origin.git"
    seed = tmp_path / "seed"
    checkout = tmp_path / "checkout"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    git(tmp_path, "clone", "-q", str(origin), str(seed))
    commit(seed, "README.md", "initial")
    git(seed, "push", "-q", "origin", "HEAD:main")
    git(tmp_path, "clone", "-q", str(origin), str(checkout))
    config = Config("example/mono", "rowantran", "PVT_example", "https://github.com/users/rowantran/projects/1",
                    checkout.resolve())
    return config, seed


@pytest.mark.parametrize("url", ["https://github.com/example/mono.git", "https://github.com/example/mono",
                                 "git@github.com:example/mono.git"])
def test_remote_canonicalization(url):
    assert github_remote_repo(url) == "example/mono"


@pytest.mark.parametrize("url", ["https://token@github.com/example/mono.git", "https://github.com.evil/owner/repo",
                                 "/tmp/repo", "ssh://evil/path"])
def test_remote_rejects_credentials_and_other_hosts(url):
    assert github_remote_repo(url) is None


def test_verify_checkout_requires_matching_github_origin(repository):
    config, _ = repository
    workspace = Workspace(config)
    with pytest.raises(OrchestratorError, match="origin"):
        workspace.verify_checkout()
    git(config.checkout, "remote", "set-url", "origin", "git@github.com:Example/Mono.git")
    workspace.verify_checkout()


@needs_wt
def test_worktree_starts_from_latest_fetched_base(repository):
    config, seed = repository
    latest = commit(seed, "new.txt", "landed on main after the clone")
    git(seed, "push", "-q", "origin", "HEAD:main")
    workspace = Workspace(config)
    created = workspace.create(42)
    assert created["branch"] == "rowantran/gh-42"
    assert created["base"] == "origin/main" and created["base_commit"] == latest
    assert git(created["path"], "rev-parse", "HEAD") == latest
    assert git(created["path"], "branch", "--show-current") == "rowantran/gh-42"
    assert workspace.worktrees()["rowantran/gh-42"] == created["path"]
    assert git(config.checkout, "status", "--porcelain") == ""


@needs_wt
def test_worktree_can_stack_on_unmerged_branch(repository):
    config, _ = repository
    workspace = Workspace(config)
    upstream = workspace.create(1)
    upstream_commit = commit(Path(upstream["path"]), "feature.txt", "unmerged upstream work")
    stacked = workspace.create(2, base="rowantran/gh-1")
    assert stacked["base"] == "rowantran/gh-1" and stacked["base_commit"] == upstream_commit
    assert (Path(stacked["path"]) / "feature.txt").read_text() == "unmerged upstream work\n"


@needs_wt
def test_existing_branch_is_reported_not_replaced(repository):
    config, _ = repository
    workspace = Workspace(config)
    first = workspace.create(7)
    with pytest.raises(OrchestratorError, match=f"already exists at {first['path']}"):
        workspace.create(7)
    git(config.checkout, "branch", "rowantran/gh-8")
    with pytest.raises(OrchestratorError, match="no worktree"):
        workspace.create(8)


def test_unknown_base_is_an_actionable_error(repository):
    config, _ = repository
    with pytest.raises(OrchestratorError, match="Unknown base 'nope'"):
        Workspace(config).create(3, base="nope")
