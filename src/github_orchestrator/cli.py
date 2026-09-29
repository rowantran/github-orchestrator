"""Human-facing commands. GitHub changes, approvals and note completion are explicit."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import uuid
import webbrowser
from pathlib import Path

from .config import Config, default_config_path, load_config
from .context import digest
from .domain import IssueRef, OrchestratorError, Run
from .github import GitHub
from .process import Commands
from .runner import Runner
from .state import process_group_alive
from .workspace import github_remote_repo


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="gho", description="Your GitHub queue → Worktrunk → sandboxed Pi.")
    root.add_argument("--config", type=Path, default=default_config_path(), help="Queue configuration TOML")
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Configure a queue; never create a project or change the source checkout")
    init.add_argument("--checkout", type=Path, default=Path.cwd())
    init.add_argument("--repo", help="OWNER/REPO; default: checkout's origin")
    init.add_argument("--owner", help="GitHub login; default: authenticated user")
    init.add_argument("--project", required=True, help="GitHub Project URL")
    init.add_argument("--model", required=True, help="Exact Isara model ID")
    init.add_argument("--isara-checkout", type=Path)
    init.add_argument("--provider-extension", type=Path)
    init.add_argument("--base", default="main")
    init.add_argument("--context-file", action="append", default=[], help="Explicit tracked guidance file (repeatable)")
    init.add_argument("--vault", type=Path, help="Optional Obsidian vault; does not modify it")
    doctor = commands.add_parser("doctor", help="Check local tools and GitHub access, without a model call")
    doctor.add_argument("--sandbox", action="store_true", help="Also create a temporary worktree and probe the real sandbox")
    status = commands.add_parser("status", help="Explain why each task is ready or blocked")
    status.add_argument("--json", action="store_true")
    status.add_argument("--no-fetch", action="store_true", help="Use the last fetched base (display only)")
    for name in ("inspect", "context"):
        item = commands.add_parser(name, help="Read an issue" if name == "inspect" else "Write an inspectable input bundle, without a model call")
        item.add_argument("issue")
    approve = commands.add_parser("approve", help="Operator: approve the exact reviewed issue/context revision")
    approve.add_argument("issue")
    approve.add_argument("--fingerprint", required=True, help="Fingerprint printed by gho context")
    approve.add_argument("--yes", action="store_true")
    revoke = commands.add_parser("revoke", help="Remove an issue's launch/publication approval")
    revoke.add_argument("issue")
    ack = commands.add_parser("ack", help="Operator: acknowledge a completed non-code prerequisite")
    ack.add_argument("issue")
    ack.add_argument("--yes", action="store_true")
    run = commands.add_parser("run", help="Run the currently ready tasks; wait for results, never auto-merge")
    run.add_argument("--issue", type=int)
    run.add_argument("--dry-run", action="store_true")
    runs = commands.add_parser("runs", help="Local run history; works offline")
    runs.add_argument("--json", action="store_true")
    logs = commands.add_parser("logs", help="Read a worker's progress and log locations")
    logs.add_argument("run_id")
    logs.add_argument("--follow", action="store_true")
    logs.add_argument("--events", action="store_true", help="Print raw JSON events")
    for name, help_text in (("publish", "Operator: commit, push and open a draft PR"),
                            ("retry", "Operator: authorize a fresh attempt; preserve old work"),
                            ("clean", "Remove a verified merged worktree; retain branch and logs")):
        item = commands.add_parser(name, help=help_text)
        item.add_argument("run_id")
        item.add_argument("--yes", action="store_true")
    recover = commands.add_parser("recover", help="Reconcile stopped workers without restarting them")
    recover.add_argument("--confirm-stopped", action="store_true", help="Also resolve the unknown-PID crash window")
    recover.add_argument("--yes", action="store_true")
    sync = commands.add_parser("sync", help="Observe merged PRs; optionally request TaskNotes completion")
    sync.add_argument("--complete-notes", action="store_true", help="Queue completion only after checking every linked issue")
    sync.add_argument("--retry-note-completion", action="store_true", help="Explicitly retry failed/stale note requests after rechecking GitHub")
    commands.add_parser("board", help="Open the configured GitHub Project")
    task = commands.add_parser("task", help="Planner helpers using real GitHub issues").add_subparsers(dest="task_command", required=True)
    create = task.add_parser("create", help="Create an assigned issue and enroll it in the Project")
    create.add_argument("--title", required=True)
    create.add_argument("--body-file", type=Path, required=True)
    create.add_argument("--blocked-by", action="append", default=[], help="Issue number/URL; repeat or comma-separate")
    create.add_argument("--note", help="Automatically link the new issue to this vault-relative task note")
    notes = commands.add_parser("notes", help="Optional TaskNotes bridge").add_subparsers(dest="notes_command", required=True)
    link = notes.add_parser("link", help="Replace an existing task note's complete set of linked GitHub issues")
    link.add_argument("note")
    link.add_argument("issues", nargs="+")
    notes.add_parser("list", help="List durable note associations")
    install = notes.add_parser("install", help="Copy the built plugin into the configured vault; never enable it")
    install.add_argument("--yes", action="store_true")
    return root


def confirm(message: str, yes: bool) -> None:
    if yes:
        return
    if not sys.stdin.isatty():
        raise OrchestratorError("This operator action needs explicit --yes or an interactive confirmation.")
    if input(f"{message} [y/N] ").strip().lower() not in {"y", "yes"}:
        raise OrchestratorError("Canceled; no change made.")


def print_json(value) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def init_config(args) -> None:
    path = args.config.expanduser().resolve()
    if path.exists():
        raise OrchestratorError(f"Config already exists: {path}. Edit it explicitly or choose --config.")
    commands = Commands()
    checkout = args.checkout.expanduser().resolve()
    remote = commands.run(["git", "remote", "get-url", "origin"], cwd=checkout).strip()
    repo = args.repo or github_remote_repo(remote)
    if not repo or github_remote_repo(remote) != repo.lower():
        raise OrchestratorError("Checkout origin must match a github.com repository (OWNER/REPO).")
    owner = args.owner or commands.run(["gh", "api", "--hostname", "github.com", "user", "--jq", ".login"]).strip()
    github = GitHub(repo, "", owner)
    project = github.resolve_project(args.project)
    isara_binary = shutil.which("isara")
    isara_root = args.isara_checkout
    if not isara_root and isara_binary:
        resolved = Path(isara_binary).resolve()
        if resolved.parent.name == "cli" and resolved.parent.parent.name == "src":
            isara_root = resolved.parents[2]
    if not isara_root:
        raise OrchestratorError("Pass --isara-checkout pointing to the Isara repo containing its CLI and .venv.")
    isara_root = isara_root.expanduser().resolve()
    provider = (args.provider_extension or isara_root / "src/project/pi_provider/isara_provider.ts").expanduser().resolve()
    slug = f"{repo.replace('/', '--').lower()}--{owner.lower()}"
    state = Path.home() / ".local/state/github-orchestrator" / slug
    work = Path.home() / ".local/share/github-orchestrator" / slug
    config = Config(repo, owner, project["id"], project["url"], checkout, state, work,
                    args.model, provider, isara_root, base_branch=args.base,
                    context_files=tuple(args.context_file), vault=args.vault.expanduser().resolve() if args.vault else None)
    config.validate()
    def q(value):
        return json.dumps(str(value), ensure_ascii=False)
    text = (
        "# Personal queue. GitHub remains the task store; no credentials belong in this file.\n[queue]\n"
        f"repo = {q(repo)}\nowner = {q(owner)}\nproject_id = {q(project['id'])}\nproject_url = {q(project['url'])}\n"
        f"checkout = {q(checkout)}\nbase_branch = {q(args.base)}\nstate_dir = {q(state)}\nworkspace_dir = {q(work)}\n\n"
        "[worker]\n"
        f"model = {q(args.model)}\nprovider_extension = {q(provider)}\nisara_checkout = {q(isara_root)}\n"
        "thinking = \"high\"\nmax_workers = 2\ntimeout_seconds = 3600\n"
        f"context_files = {json.dumps(args.context_file)}\n"
    )
    if config.vault:
        text += f"\n[obsidian]\nvault = {q(config.vault)}\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as handle:
        handle.write(text)
    path.chmod(0o600)
    print(f"Configured {repo} for {owner}: {path}\nBoard: {project['url']}\nNext: gho doctor")


def notes_for(config: Config):
    from .notes import Notes
    if not config.vault:
        raise OrchestratorError("Set [obsidian].vault in your queue config first.")
    return Notes(config.vault)


def display_status(items, as_json: bool = False) -> None:
    rows = [{"number": item.issue.ref.number, "title": item.issue.title, "url": item.issue.ref.url,
             "ready": item.ready, "reason": item.reason, "fingerprint": item.fingerprint} for item in items]
    if as_json:
        print_json(rows)
        return
    if not rows:
        print("Your queue is empty. Only assigned issues enrolled in the configured Project appear here.")
    for row in rows:
        print(f"#{row['number']:<6} {'READY' if row['ready'] else 'WAIT ':5} {row['title']}\n         {row['reason']}")


def display_runs(runs: list[Run], as_json: bool = False) -> None:
    if as_json:
        print_json([run.as_dict() for run in runs])
        return
    if not runs:
        print("No runs. Inspect and approve a task, then use gho run.")
    for run in runs:
        print(f"{run.id}  {run.status}\n  {run.pr_url or run.issue_url}\n  {run.detail or run.worktree}")


def show_logs(runner: Runner, args) -> None:
    run = runner.store.get(args.run_id)
    root = runner.config.state_dir / "attempts" / run.id
    path = root / "events.jsonl"
    print(f"Events: {path}\nDiagnostics: {root / 'stderr.log'}", file=sys.stderr)
    if not path.exists():
        print(run.detail or "Worker has not started.")
        return
    with path.open(encoding="utf-8", errors="replace", newline="\n") as handle:
        while True:
            line = handle.readline()
            if line:
                if args.events:
                    print(line, end="", flush=True)
                    continue
                try:
                    event = json.loads(line)
                    if event.get("type") == "tool_execution_start":
                        print(f"→ {event.get('toolName')}", flush=True)
                    if event.get("type") == "message_update":
                        update = event.get("assistantMessageEvent", {})
                        if update.get("type") == "text_delta":
                            print(update.get("delta", ""), end="", flush=True)
                except (ValueError, AttributeError):
                    print(line, end="", flush=True)
            elif args.follow and process_group_alive(runner.store.get(run.id).pid):
                time.sleep(0.2)
            else:
                break
    if not args.events:
        print()


def doctor(runner: Runner, probe: bool) -> None:
    c = runner.config
    failures = []
    for name in ("git", "gh", "wt", "pi", "isara", "srt"):
        path = shutil.which(c.executable(name))
        print(f"{'OK  ' if path else 'FAIL'} {name}: {path or 'not found'}")
        if not path:
            failures.append(name)
    try:
        runner.workspace.verify_checkout()
        runner.sandbox.prerequisites()
        print(f"OK   Pi runtime and isolated-worker prerequisites; owner {c.owner}")
        count = len(runner.github.queue())
        print(f"OK   GitHub project access; {count} owned, open issue(s)")
    except OrchestratorError as exc:
        failures.append(str(exc))
        print(f"FAIL {exc}")
    if probe and not failures:
        with runner.store.lock():
            base = runner.workspace.fetch()
            run_id = f"probe-{uuid.uuid4().hex[:12]}"
            run = Run(run_id, "", "", "preparing", f"{c.owner}/agents/{run_id}", str(c.tasks_dir / run_id), base)
            runner.workspace.create(run)
            runner.sandbox.prepare(Path(run.worktree))
            runner.workspace._wt(["remove", run.branch, "--foreground", "--no-delete-branch", "--no-hooks"])
            print("OK   Real OS sandbox: local writes allowed; host state, policy and inputs protected. No model called.")
    if failures:
        raise OrchestratorError("Doctor found missing prerequisites. GitHub Projects access may need: gh auth refresh -s project")


def sync_notes(runner: Runner, notes, *, retry: bool = False) -> None:
    # Serialize state lookup + request creation across local CLI processes.
    with runner.store.lock():
        links = notes.links()
        if not links:
            print("No linked task notes.")
            return
        base = runner.workspace.fetch()
        for link in links:
            state = notes.completion_state(link)
            if state and state["status"] in {"pending", "processing", "local-accepted", "already-done"}:
                print(f"{link['notePath']}: {state['status']} (Notion persistence is not confirmed)")
                continue
            if state and not retry:
                print(f"{link['notePath']}: {state['status']}; inspect the receipt before --retry-note-completion")
                continue
            try:
                for url in link["issueUrls"]:
                    runner.require_completed(runner.github.issue(IssueRef.parse(url)), base)
            except OrchestratorError as exc:
                print(f"Waiting: {link['notePath']}: {exc}")
                continue
            print_json(notes.request_completion(link))


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "init":
            init_config(args)
            return 0
        config = load_config(args.config)
        runner = Runner(config)
        exit_code = 0

        def ref(value):
            return IssueRef.parse(value, config.repo)
        if args.command == "doctor":
            doctor(runner, args.sandbox)
        elif args.command == "status":
            display_status(runner.status(fetch=not args.no_fetch), args.json)
        elif args.command in {"inspect", "context"}:
            issue = runner.github.issue(ref(args.issue))
            runner.require_owned(issue)
            if args.command == "inspect":
                print(f"#{issue.ref.number}: {issue.title}\n{issue.ref.url}\n\n{issue.body}\n")
                print("Blocked by: " + (", ".join(b.key for b in issue.blockers) or "none"))
            else:
                with runner.store.lock():
                    base = runner.workspace.fetch()
                    snapshot = runner.context.snapshot(issue, base)
                    fingerprint = digest(snapshot)
                    path = config.state_dir / "previews" / f"{issue.ref.number}-{uuid.uuid4().hex[:8]}"
                    bundle = runner.context.bundle(snapshot, run_id="preview", branch="assigned-at-launch", base_commit=base)
                    runner.context.write_bundle(path, bundle)
                    size = sum(len(bundle[name].encode()) for name in ("system.md", "append.md", "task.md", "isara-bootstrap.txt", "tool-definitions.json"))
                    print(f"Context bundle: {path}\nFingerprint: {fingerprint}\nAuthored input: {size:,} UTF-8 bytes (~{size // 4:,} tokens; estimate, not billing).")
                    print("Review system.md, append.md, task.md, isara-bootstrap.txt and tool-definitions.json.")
                    print(f"Next: gho approve {issue.ref.number} --fingerprint {fingerprint}")
        elif args.command == "approve":
            confirm(f"Approve the reviewed task/context fingerprint for {args.issue}?", args.yes)
            print("Approved: " + runner.approve(ref(args.issue), args.fingerprint))
        elif args.command == "revoke":
            # Revocation must work while a dispatcher holds its long-lived execution lock.
            runner.store.revoke(ref(args.issue).url)
            print("Approval revoked. A running process is not silently terminated; publication will be refused.")
        elif args.command == "ack":
            issue = runner.github.issue(ref(args.issue))
            if not issue.completed:
                raise OrchestratorError("Only successfully completed non-code prerequisites can be acknowledged.")
            confirm(f"Acknowledge {issue.ref.url} as non-code work (no code-integration check)?", args.yes)
            with runner.store.lock():
                runner.store.acknowledge(issue.ref.url, digest(issue.plan()))
            print("Non-code prerequisite acknowledged for this exact issue revision.")
        elif args.command == "run":
            print("Checking your queue; no issue is claimed without matching approval.", file=sys.stderr)
            result = runner.run_ready(issue_number=args.issue, dry_run=args.dry_run)
            display_status(result) if args.dry_run else display_runs(result)
            if not args.dry_run and any(run.status in {"failed", "blocked", "interrupted"} for run in result):
                exit_code = 1
        elif args.command == "runs":
            display_runs(runner.store.runs(), args.json)
        elif args.command == "logs":
            show_logs(runner, args)
        elif args.command == "publish":
            run = runner.store.get(args.run_id)
            print("Changed paths:\n" + "\n".join(runner.workspace.changed_files(run)))
            confirm("Commit and publish this reviewed work as a draft PR?", args.yes)
            display_runs([runner.publish(run.id)])
        elif args.command == "retry":
            confirm("Authorize a fresh attempt from the latest base? The old worktree is preserved, not resumed.", args.yes)
            with runner.store.lock():
                run = runner.store.retry(args.run_id)
            print(f"Retry authorized for {run.issue_url}. Inspect/reapprove any changed plan, then gho run.")
        elif args.command == "recover":
            if args.confirm_stopped:
                confirm("Confirm workers with no recorded PID are stopped? Check processes before continuing.", args.yes)
            display_runs(runner.recover(confirm_stopped=args.confirm_stopped))
        elif args.command == "clean":
            confirm("Remove this merged worktree? Branch and captured logs remain.", args.yes)
            with runner.store.lock():
                run = runner.store.get(args.run_id)
                if process_group_alive(run.pid):
                    raise OrchestratorError("Worker process group still exists.")
                if run.status != "merged":
                    raise OrchestratorError("Only a verified merged run can be cleaned.")
                runner.workspace.verify(run)
                sessions = Path(run.worktree) / ".gho/sessions"
                destination = config.state_dir / "attempts" / run.id / "sessions"
                if sessions.exists():
                    if (not sessions.resolve().is_relative_to(Path(run.worktree).resolve())
                            or sessions.is_symlink() or any(p.is_symlink() for p in sessions.rglob("*"))):
                        raise OrchestratorError("Unexpected symlink in sessions; refusing cleanup.")
                    shutil.copytree(sessions, destination, dirs_exist_ok=True)
                runner.workspace.cleanup(run)
            print("Worktree removed; branch, session and logs retained.")
        elif args.command == "sync":
            display_runs(runner.sync())
            if args.retry_note_completion and not args.complete_notes:
                raise OrchestratorError("Use --retry-note-completion together with --complete-notes.")
            if args.complete_notes:
                sync_notes(runner, notes_for(config), retry=args.retry_note_completion)
        elif args.command == "board":
            webbrowser.open(config.project_url)
            print(config.project_url)
        elif args.command == "task":
            body = args.body_file.read_text()
            if not body.strip():
                raise OrchestratorError("Issue body is empty.")
            blockers = tuple(ref(part.strip()) for group in args.blocked_by for part in group.split(","))
            issue = runner.github.create_issue(args.title, body, blockers)
            print(issue.ref.url, flush=True)
            if args.note:
                try:
                    print_json(notes_for(config).add(args.note, [issue.ref.url]))
                except Exception as exc:
                    raise OrchestratorError(f"Issue was created at {issue.ref.url}; note linking failed: {exc}. Do not recreate it.") from exc
        elif args.command == "notes":
            notes = notes_for(config)
            if args.notes_command == "link":
                print_json(notes.link(args.note, [ref(value).url for value in args.issues]))
            elif args.notes_command == "list":
                print_json(notes.links())
            else:
                confirm("Copy the built GitHub Orchestrator plugin into your vault (without enabling it)?", args.yes)
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
        for warning in dict.fromkeys(runner.warnings):
            print(f"Warning: {warning}", file=sys.stderr)
        return exit_code
    except KeyboardInterrupt:
        print("\nInterrupted. Work and logs are retained; use gho runs and gho recover.", file=sys.stderr)
        return 130
    except (OrchestratorError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"gho: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
