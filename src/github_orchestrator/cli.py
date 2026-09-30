"""The gho command: register work, find ready work, create worktrees. Agents are launched by the orchestrator."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from .config import Config, default_config_path, load_config
from .domain import IssueRef, OrchestratorError
from .github import GitHub
from .process import Commands
from .work import survey
from .workspace import Workspace, github_remote_repo


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="gho", description="Your GitHub issue queue → ready work → Worktrunk worktrees.")
    root.add_argument("--config", type=Path, default=default_config_path(), help="Queue configuration TOML")
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Write a queue config; never creates a Project")
    init.add_argument("--checkout", type=Path, default=Path.cwd(), help="Repository checkout that gets the worktrees")
    init.add_argument("--repo", help="OWNER/REPO; default: checkout's origin")
    init.add_argument("--owner", help="GitHub login; default: authenticated user")
    init.add_argument("--project", required=True, help="GitHub Project URL")
    init.add_argument("--base", default="main", help="Default base branch for new worktrees")
    init.add_argument("--vault", type=Path, help="Optional Obsidian vault for the TaskNotes bridge")
    commands.add_parser("doctor", help="Check git, gh, wt and GitHub Project access")
    ready = commands.add_parser("ready", help="List queue issues whose blockers are all done")
    ready.add_argument("--all", action="store_true", help="Also list blocked and in-progress issues")
    ready.add_argument("--json", action="store_true")
    worktree = commands.add_parser("worktree", help="Create the issue's branch and worktree; prints JSON")
    worktree.add_argument("issue")
    worktree.add_argument("--base", help="Branch or commit to stack on (default: latest origin/<base branch>)")
    task = commands.add_parser("task", help="Register work as GitHub issues").add_subparsers(dest="task_command", required=True)
    create = task.add_parser("create", help="Create an issue assigned to you and add it to the Project")
    create.add_argument("--title", required=True)
    create.add_argument("--body-file", type=Path, required=True)
    create.add_argument("--blocked-by", action="append", default=[], help="Issue number/URL; repeat or comma-separate")
    create.add_argument("--note", help="Also link the new issue to this vault-relative task note")
    notes = commands.add_parser("notes", help="Optional TaskNotes bridge").add_subparsers(dest="notes_command", required=True)
    link = notes.add_parser("link", help="Replace an existing task note's complete set of linked GitHub issues")
    link.add_argument("note")
    link.add_argument("issues", nargs="+")
    notes.add_parser("list", help="List note associations")
    complete = notes.add_parser("complete", help="Request TaskNotes completion for notes whose issues are all done")
    complete.add_argument("--retry", action="store_true", help="Retry failed or stale requests")
    install = notes.add_parser("install", help="Copy the built plugin into the configured vault; never enable it")
    install.add_argument("--yes", action="store_true")
    return root


def confirm(message: str, yes: bool) -> None:
    if yes:
        return
    if not sys.stdin.isatty():
        raise OrchestratorError("This action needs --yes or an interactive confirmation.")
    if input(f"{message} [y/N] ").strip().lower() not in {"y", "yes"}:
        raise OrchestratorError("Canceled; no change made.")


def print_json(value) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def init_config(args) -> None:
    path = args.config.expanduser().resolve()
    if path.exists():
        raise OrchestratorError(f"Config already exists: {path}. Edit it directly or choose --config.")
    commands = Commands()
    checkout = args.checkout.expanduser().resolve()
    remote = commands.run(["git", "remote", "get-url", "origin"], cwd=checkout).strip()
    repo = args.repo or github_remote_repo(remote)
    if not repo or github_remote_repo(remote) != repo.lower():
        raise OrchestratorError("Checkout origin must match a github.com repository (OWNER/REPO).")
    owner = args.owner or commands.run(["gh", "api", "--hostname", "github.com", "user", "--jq", ".login"]).strip()
    project = GitHub(repo, "", owner).resolve_project(args.project)
    vault = args.vault.expanduser().resolve() if args.vault else None
    Config(repo, owner, project["id"], project["url"], checkout, args.base, vault).validate()

    def q(value):
        return json.dumps(str(value), ensure_ascii=False)
    text = (
        "# GitHub remains the task store; no credentials belong in this file.\n[queue]\n"
        f"repo = {q(repo)}\nowner = {q(owner)}\nproject_id = {q(project['id'])}\nproject_url = {q(project['url'])}\n"
        f"checkout = {q(checkout)}\nbase_branch = {q(args.base)}\n"
    )
    if vault:
        text += f"\n[obsidian]\nvault = {q(vault)}\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as handle:
        handle.write(text)
    print(f"Configured {repo} for {owner}: {path}\nBoard: {project['url']}\nNext: gho doctor")


def notes_for(config: Config):
    from .notes import Notes
    if not config.vault:
        raise OrchestratorError("Set [obsidian].vault in your queue config first.")
    return Notes(config.vault)


def display_ready(items: list[dict], show_all: bool, as_json: bool) -> None:
    if not show_all:
        items = [item for item in items if item["state"] == "ready"]
    if as_json:
        print_json(items)
        return
    if not items:
        print("Nothing ready." if not show_all else "Your queue is empty (open issues assigned to you in the Project).")
    for item in items:
        print(f"{item['state'].upper():<12} #{item['number']:<6} {item['title']}")
        if item["worktree"]:
            print(f"{'':20}{item['worktree']}")
        for blocker in item["blockers"]:
            if not blocker["done"]:
                where = f"branch {blocker['branch']}" if blocker["branch"] else blocker["state"].lower()
                print(f"{'':20}waits on {blocker['repo']}#{blocker['number']} ({where})")


def doctor(config: Config, github: GitHub, workspace: Workspace) -> None:
    failures = []
    for name in ("git", "gh", "wt"):
        path = shutil.which(config.executable(name))
        print(f"{'OK  ' if path else 'FAIL'} {name}: {path or 'not found'}")
        if not path:
            failures.append(name)
    try:
        workspace.verify_checkout()
        print(f"OK   checkout {config.checkout} matches {config.repo}")
        print(f"OK   GitHub Project access; {len(github.queue())} open issue(s) assigned to {config.owner}")
    except OrchestratorError as exc:
        failures.append(str(exc))
        print(f"FAIL {exc}")
    if failures:
        raise OrchestratorError("Doctor found problems. GitHub Projects access may need: gh auth refresh -s project")


def complete_notes(github: GitHub, notes, *, retry: bool = False) -> None:
    links = notes.links()
    if not links:
        print("No linked task notes.")
        return
    for link in links:
        state = notes.completion_state(link)
        if state and state["status"] in {"pending", "processing", "local-accepted", "already-done"}:
            print(f"{link['notePath']}: {state['status']}")
            continue
        if state and not retry:
            print(f"{link['notePath']}: {state['status']}; inspect the receipt, then use --retry")
            continue
        open_issues = [url for url in link["issueUrls"] if not github.issue(IssueRef.parse(url)).completed]
        if open_issues:
            print(f"Waiting: {link['notePath']}: not completed: {', '.join(open_issues)}")
            continue
        print_json(notes.request_completion(link))


def install_plugin(config: Config, yes: bool) -> None:
    confirm("Copy the built GitHub Orchestrator plugin into your vault (without enabling it)?", yes)
    source = Path(__file__).resolve().parents[2] / "obsidian-plugin"
    destination = config.vault / ".obsidian/plugins/github-orchestrator"
    required = [source / name for name in ("main.js", "manifest.json")]
    if not all(path.is_file() for path in required):
        raise OrchestratorError(f"Build the optional plugin first: cd {source} && npm ci && npm run build")
    for path in (destination, *destination.parents):
        if path == config.vault:
            break
        if path.is_symlink():
            raise OrchestratorError("Refusing a symlink in the plugin installation path.")
    if any((destination / path.name).is_symlink() for path in required):
        raise OrchestratorError("Refusing to replace a symlinked plugin file.")
    destination.mkdir(parents=True, exist_ok=True)
    for path in required:
        shutil.copy2(path, destination / path.name)
    print(f"Installed to {destination}. Enable GitHub Orchestrator in Obsidian Community plugins.")


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "init":
            init_config(args)
            return 0
        config = load_config(args.config)
        github = GitHub(config.repo, config.project_id, config.owner)
        workspace = Workspace(config)

        def ref(value):
            return IssueRef.parse(value, config.repo)
        if args.command == "doctor":
            doctor(config, github, workspace)
        elif args.command == "ready":
            display_ready(survey(github, workspace), args.all, args.json)
        elif args.command == "worktree":
            issue = ref(args.issue)
            if issue.repo.lower() != config.repo.lower():
                raise OrchestratorError(f"Worktrees are only created for {config.repo} issues.")
            print_json(workspace.create(issue.number, args.base))
        elif args.command == "task":
            body = args.body_file.read_text()
            if not body.strip():
                raise OrchestratorError("Issue body is empty.")
            blockers = tuple(ref(part.strip()) for group in args.blocked_by for part in group.split(","))
            issue = github.create_issue(args.title, body, blockers)
            print(issue.ref.url, flush=True)
            if args.note:
                try:
                    print_json(notes_for(config).add(args.note, [issue.ref.url]))
                except Exception as exc:
                    raise OrchestratorError(f"Issue was created at {issue.ref.url}; note linking failed: {exc}. Do not recreate it.") from exc
        elif args.command == "notes":
            if args.notes_command == "link":
                print_json(notes_for(config).link(args.note, [ref(value).url for value in args.issues]))
            elif args.notes_command == "list":
                print_json(notes_for(config).links())
            elif args.notes_command == "complete":
                complete_notes(github, notes_for(config), retry=args.retry)
            else:
                notes_for(config)
                install_plugin(config, args.yes)
        return 0
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    except (OrchestratorError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"gho: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
