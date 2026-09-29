"""Opt-in real Isara/Seatbelt regressions; all writable targets are disposable.

Run with GHO_ISARA_CHECKOUT=/path/to/isara uv run pytest tests/test_sandbox.py.
No Isara CLI entry point, credential minting, model call, or GitHub request runs.
"""

import json
import os
import platform
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pytest

from github_orchestrator.config import Config
from github_orchestrator.context import ContextBuilder
from github_orchestrator.domain import Issue, IssueRef, Run
from github_orchestrator.runner import Runner, check_audit, check_events
from github_orchestrator.sandbox import Sandbox
from github_orchestrator.workspace import Workspace

pytestmark = pytest.mark.skipif(
    not os.environ.get("GHO_ISARA_CHECKOUT") or platform.system() != "Darwin",
    reason="Opt-in actual Isara/Seatbelt test: set GHO_ISARA_CHECKOUT on macOS",
)


@dataclass
class Worker:
    config: Config
    workspace: Workspace
    run: Run
    sibling: Run
    sandbox: Sandbox
    policy: dict

    @property
    def path(self):
        return Path(self.run.worktree)

    @property
    def settings(self):
        return self.path / ".gho/input/resolved-sandbox.json"

    def shell(self, script, *args):
        # An explicit completion marker prevents a failed sandbox startup from
        # masquerading as a successful write-denial test.
        output = self.sandbox.commands.run(
            [self.config.executable("srt"), "--settings", str(self.settings), "--",
             "/bin/sh", "-c", "set -eu\n" + script + "\nprintf '\\nsandbox-finished\\n'",
             "sandbox-test", *(str(arg) for arg in args)],
            cwd=self.path, env=self.sandbox.environment(self.path), timeout=30,
        )
        assert output.splitlines()[-1] == "sandbox-finished", output
        return output


@pytest.fixture
def worker(monkeypatch):
    for executable in ("srt", "wt", "pi", "isara"):
        if shutil.which(executable) is None:
            pytest.skip(f"Real sandbox integration requires installed {executable}")
    isara = Path(os.environ["GHO_ISARA_CHECKOUT"]).expanduser().resolve()
    assert (isara / ".venv/bin/python").is_file(), "GHO_ISARA_CHECKOUT must have its actual venv"

    # HOME stays real: Isara discovers a linked worktree's policy at the main
    # clone below HOME. Everything the tests create lives inside this one root.
    with tempfile.TemporaryDirectory(prefix="gho-sandbox-test-", dir=Path.home()) as temporary:
        root = Path(temporary)
        # Do not pass ambient credentials or Git/Pi hooks into fixture commands.
        keep = {"HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME"}
        for key in list(os.environ):
            if key not in keep:
                monkeypatch.delenv(key)
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
        monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
        monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "1")
        monkeypatch.setenv("PI_OFFLINE", "1")
        monkeypatch.setenv("DO_NOT_TRACK", "1")
        temporary_files = root / "tmp"
        temporary_files.mkdir()
        monkeypatch.setenv("TMPDIR", str(temporary_files))
        source = root / "source"
        source.mkdir()

        def git(*args):
            return subprocess.check_output(
                ["git", "-C", str(source), "-c", "core.hooksPath=/dev/null",
                 "-c", "core.fsmonitor=false", *args], text=True, stderr=subprocess.PIPE, timeout=30,
            ).strip()

        git("init", "-b", "main", "--template=")
        git("config", "user.name", "Sandbox Test")
        git("config", "user.email", "sandbox@example.invalid")
        git("config", "commit.gpgsign", "false")
        git("remote", "add", "origin", "https://github.com/example/sandbox-fixture.git")
        (source / "README.md").write_text("original fixture\n")
        git("add", "README.md")
        git("commit", "-m", "fixture")
        config = Config(
            "example/sandbox-fixture", "fixture", "PVT_fixture", "https://example.invalid/project",
            source, root / "state", root / "work", "unused-no-model",
            isara / "src/project/pi_provider/isara_provider.ts", isara,
            context_files=("README.md",),
        )
        config.state_dir.mkdir()
        (config.state_dir / "sentinel").write_text("host state\n")
        workspace = Workspace(config)
        workspace.ensure_clone()

        def create(name):
            run = Run(name, "https://github.com/example/sandbox-fixture/issues/1", "hash", "preparing",
                      f"fixture/{name}", str(config.tasks_dir / name), workspace.git("rev-parse", "HEAD"))
            workspace.create(run)
            return run

        run, sibling = create("worker"), create("sibling")
        sandbox = Sandbox(config)
        policy = sandbox.prepare(Path(run.worktree))
        (Path(run.worktree) / ".gho/input/context.json").write_text('{"reviewed": true}\n')
        yield Worker(config, workspace, run, sibling, sandbox, policy)


def test_resolved_policy_and_real_pi_shim(worker):
    assert worker.policy["filesystem"]["allowWrite"] == ["."]
    assert not worker.policy["network"].get("allowMachLookup")
    assert not worker.policy["network"].get("allowUnixSockets")
    assert json.loads(worker.settings.read_text()) == worker.policy
    output = worker.sandbox.commands.run(
        ["srt", "--settings", str(worker.settings), "--", str(worker.path / ".gho/bin/pi"), "--version"],
        cwd=worker.path, env=worker.sandbox.environment(worker.path), timeout=30,
    )
    assert output.strip() == "0.87.1"


def test_real_sandbox_runs_copied_worker_and_local_provider(worker):
    inputs = worker.path / ".gho/input"
    builder = ContextBuilder(worker.config, worker.workspace)
    issue = Issue(IssueRef(worker.config.repo, 1), "Offline sandbox fixture",
                  "Disposable task with literal {{branch}} text.", "OPEN", None)
    snapshot = builder.snapshot(issue, worker.run.base_commit)
    bundle = builder.bundle(snapshot, run_id=worker.run.id, branch=worker.run.branch,
                            base_commit=worker.run.base_commit)
    # Replace only this fixture's placeholder, not an approved production input.
    (inputs / "context.json").unlink()
    builder.write_bundle(inputs, bundle)
    guard = inputs / "no-network.cjs"
    guard.write_text(r"""
// Purpose: block network inside Pi only. Audience: tests. Injection: Node preload, never a model.
const { writeSync } = require("node:fs");
const deny = () => { writeSync(2, "NETWORK_ATTEMPT_DENIED_BY_OFFLINE_TEST\n"); process.exit(89); };
globalThis.fetch = deny;
require("node:net").Socket.prototype.connect = deny;
require("node:tls").connect = deny;
for (const protocol of ["node:http", "node:https"]) {
  require(protocol).request = deny;
  require(protocol).get = deny;
}
require("node:dns").lookup = deny;
require("node:dns").promises.lookup = deny;
require("node:module").syncBuiltinESMExports();
globalThis.__ghoOfflineGuard = true;
""")
    provider = inputs / "fake-provider.ts"
    provider.write_text(r"""
// Purpose: local fixed stream and runtime assertions. Audience: tests. Injection: test extension only.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools }
  from "@earendil-works/pi-ai";
export default function (pi) {
  assert.equal(globalThis.__ghoOfflineGuard, true);
  const faux = fauxProvider({ provider: "gho-offline", api: "gho-offline-local",
    models: [{ id: "audit-test", input: ["text"], reasoning: false }] });
  faux.setResponses([(context, _options, state) => {
    assert.equal(state.callCount, 1);
    const audit = JSON.parse(readFileSync(join(process.cwd(), ".gho/effective-context.json"), "utf8"));
    const systemPrompt = getCurrentSystemPrompt(context.messages);
    const tools = getCurrentTools(context.messages);
    const selected = (items) => items.map(({ name, description, parameters }) =>
      ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(audit.system_prompt, systemPrompt);
    assert.deepEqual(selected(audit.tools), selected(tools));
    // Check the actual Pi process remains confined after loading/transpiling extensions.
    for (const name of ["context.json", "pi/worker.ts", "fake-provider.ts"]) {
      assert.throws(() => appendFileSync(join(process.cwd(), ".gho/input", name), "tampered"),
        (error) => ["EACCES", "EPERM"].includes(error.code));
    }
    writeFileSync(join(process.cwd(), ".gho/provider-observed.json"), JSON.stringify({
      callCount: state.callCount, systemPrompt, tools, cwd: process.cwd(),
      home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR,
      temporary: process.env.TMPDIR, guard: globalThis.__ghoOfflineGuard,
    }));
    return fauxAssistantMessage("offline-sandbox-ok");
  }]);
  pi.registerProvider(faux.provider);
}
""")
    for directory in (inputs / "pi", *(inputs / "pi").parents):
        assert not (directory / "node_modules").exists(), directory
    before = {path.relative_to(inputs): path.read_bytes() for path in inputs.rglob("*") if path.is_file()}
    # Derive production worker flags from Runner, but never invoke its Isara
    # launcher (which mints credentials even when the downstream provider is fake).
    runner = Runner(worker.config, github=object(), workspace=worker.workspace, sandbox=worker.sandbox)
    argv = runner.argv(worker.run)
    args = argv[argv.index("--") + 1:]
    for flag, value in (("--extension", str(provider)), ("--provider", "gho-offline"), ("--model", "audit-test")):
        args[args.index(flag) + 1] = value
    args = ["--append-system-prompt", str(inputs / "isara-bootstrap.txt"), *args]
    env = worker.sandbox.environment(worker.path)
    env.update({"CI": "1", "NO_COLOR": "1", "PI_OFFLINE": "1",
                "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"})
    assert "NODE_OPTIONS" not in env
    # /usr/bin/env sets the preload AFTER srt starts. Blocking srt's own proxy
    # setup would test the harness instead of the sandboxed Pi process.
    child = subprocess.run(
        ["srt", "--settings", str(worker.settings), "--", "/usr/bin/env",
         f"NODE_OPTIONS=--require={guard}", str(worker.path / ".gho/bin/pi"), *args],
        cwd=worker.path, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=45,
    )
    assert child.returncode == 0, f"Pi stderr:\n{child.stderr}\nPi stdout:\n{child.stdout}"
    for failure in ("NETWORK_ATTEMPT_DENIED", "Extension error", "Failed to load extension"):
        assert failure not in child.stderr, child.stderr
    event_file = worker.config.state_dir / "offline-events.jsonl"
    event_file.write_text(child.stdout)
    check_events(event_file, worker.path)
    events = [json.loads(line) for line in child.stdout.splitlines() if line.strip()]
    assert events[0]["type"] == "session"
    assert events[0]["id"] == worker.run.id
    assert events[0]["cwd"] == str(worker.path)
    assistant = [event["message"] for event in events
                 if event["type"] == "message_end" and event["message"]["role"] == "assistant"][-1]
    assert assistant["provider"] == "gho-offline"
    assert assistant["content"] == [{"type": "text", "text": "offline-sandbox-ok"}]
    raw_audit = (worker.path / ".gho/effective-context.json").read_text()
    check_audit(raw_audit, worker.run, inputs)
    audit = json.loads(raw_audit)
    observed = json.loads((worker.path / ".gho/provider-observed.json").read_text())
    assert observed["callCount"] == 1
    assert observed["guard"] is True
    assert observed["cwd"] == str(worker.path)
    assert observed["home"] == str(worker.path / ".gho/home")
    assert observed["agentDir"] == str(worker.path / ".gho/home/.pi/agent")
    assert observed["temporary"] == str(worker.path / ".gho/tmp")
    assert audit["system_prompt"] == observed["systemPrompt"]
    assert "literal {{branch}}" in audit["task_prompt"]
    assert audit["checks"] == {"bootstrap_present": True, "explicit_context_present": True,
                               "discovered_context_files": 0, "discovered_skills": 0}
    sessions = list((worker.path / ".gho/sessions").glob("*.jsonl"))
    assert len(sessions) == 1
    session = [json.loads(line) for line in sessions[0].read_text().splitlines() if line.strip()]
    assert session[0]["id"] == worker.run.id
    assert session[0]["cwd"] == str(worker.path)
    assert any(entry.get("message", {}).get("content") == assistant["content"] for entry in session)
    # The installed Pi/jiti loader must also be able to cache its compiled
    # extensions in the shim's private TMPDIR, not beside the read-only sources.
    cache_files = [path for path in (worker.path / ".gho/tmp").rglob("*") if path.is_file()]
    assert any("jiti" in path.parts and "worker" in path.name for path in cache_files), cache_files
    assert any("jiti" in path.parts and "fake-provider" in path.name for path in cache_files), cache_files
    after = {path.relative_to(inputs): path.read_bytes() for path in inputs.rglob("*") if path.is_file()}
    assert after == before  # no edits or loader cache writes inside the frozen inputs
    worker.workspace.verify(worker.run)


def test_writes_allowed_only_to_worker_outputs(worker):
    worker.shell("""
        printf 'edited\\n' > README.md
        printf '{}\\n' > .gho/result.json
        for directory in .gho/home .gho/tmp .gho/sessions; do
            printf 'local\\n' > "$directory/allowed"
        done
    """)
    assert (worker.path / "README.md").read_text() == "edited\n"
    assert (worker.path / ".gho/result.json").read_text() == "{}\n"
    for directory in ("home", "tmp", "sessions"):
        assert (worker.path / ".gho" / directory / "allowed").read_text() == "local\n"
    worker.workspace.verify(worker.run)


def test_original_sibling_state_git_and_control_writes_denied(worker):
    existing = [
        worker.config.checkout / "README.md",
        Path(worker.sibling.worktree) / "README.md",
        worker.config.state_dir / "sentinel",
        worker.config.clone / ".git/config",
        worker.config.clone / "security_profile.json",
        worker.path / ".git",
        worker.path / ".gho/input/context.json",
        worker.path / ".gho/bin/pi",
        worker.settings,
    ]
    snapshots = {path: path.read_bytes() for path in existing}
    # Also cover creation: append denials alone do not prove directory protection.
    created = [directory / "forbidden-new" for directory in (
        worker.config.checkout, Path(worker.sibling.worktree), worker.config.state_dir,
        worker.config.clone, worker.path / ".gho/input", worker.path / ".gho/bin",
    )]
    output = worker.shell("""
        for target do
            if (printf 'forbidden\\n' >> "$target") 2>/dev/null; then
                printf 'WRITE ALLOWED: %s\\n' "$target"
            else
                printf 'write-denied\\n'
            fi
        done
    """, *existing, *created)
    assert "WRITE ALLOWED" not in output, output
    assert output.count("write-denied\n") == len(existing) + len(created)
    assert all(path.read_bytes() == before for path, before in snapshots.items())
    assert all(not path.exists() for path in created)


@pytest.mark.parametrize("link_kind", ["hardlink", "symlink"])
def test_writable_alias_cannot_modify_protected_files(worker, link_kind):
    targets = [
        worker.path / ".gho/input/context.json", worker.path / ".gho/bin/pi", worker.path / ".git",
        worker.config.clone / ".git/config", worker.config.checkout / "README.md",
        Path(worker.sibling.worktree) / "README.md", worker.config.state_dir / "sentinel",
    ]
    snapshots = {path: path.read_bytes() for path in targets}
    output = worker.shell("""
        kind="$1"
        shift
        make_link() {
            if [ "$kind" = symlink ]; then /bin/ln -s "$1" "$2";
            else /bin/ln "$1" "$2"; fi
        }
        printf 'local\\n' > link-control
        make_link link-control link-control-alias
        printf 'allowed\\n' >> link-control-alias
        index=0
        for target do
            index=$((index + 1))
            if make_link "$target" "alias-$index" 2>/dev/null; then
                if (printf 'tampered\\n' >> "alias-$index") 2>/dev/null; then
                    printf 'ALIAS WRITE ALLOWED: %s\\n' "$target"
                else
                    printf 'alias-write-denied\\n'
                fi
            else
                printf 'alias-link-denied\\n'
            fi
        done
    """, link_kind, *targets)
    assert (worker.path / "link-control").read_text() == "local\nallowed\n"
    assert "ALIAS WRITE ALLOWED" not in output, output
    assert output.count("-denied\n") == len(targets), output
    assert all(path.read_bytes() == before for path, before in snapshots.items())


@pytest.mark.parametrize("target", ["input/context.json", "bin/pi"])
def test_renaming_control_parent_cannot_bypass_protected_children(worker, target):
    protected = worker.path / ".gho" / target
    original = protected.read_bytes()
    output = worker.shell("""
        if /bin/mv .gho .gho-renamed 2>/dev/null; then
            printf 'PARENT RENAME ALLOWED\\n'
            if (printf 'tampered\\n' > ".gho-renamed/$1") 2>/dev/null; then
                printf 'MOVED CHILD WRITE ALLOWED\\n'
            fi
            if /bin/mkdir -p ".gho/${1%/*}" 2>/dev/null; then
                if (printf 'replacement\\n' > ".gho/$1") 2>/dev/null; then
                    printf 'ORIGINAL CHILD REPLACEMENT ALLOWED\\n'
                fi
            fi
        else
            printf 'parent-rename-denied\\n'
        fi
    """, target)
    assert "PARENT RENAME ALLOWED" not in output, output
    assert "parent-rename-denied" in output, output
    assert protected.read_bytes() == original
    assert not (worker.path / ".gho-renamed").exists()


@pytest.mark.parametrize("operation", ["rename", "unlink", "replace"])
def test_worktree_git_pointer_cannot_be_replaced(worker, operation):
    pointer = worker.path / ".git"
    original = pointer.read_bytes()
    output = worker.shell("""
        printf 'gitdir: .gho/fake-git\\n' > replacement-git
        case "$1" in
            rename) if /bin/mv .git saved-git 2>/dev/null; then
                        printf 'GIT RENAME ALLOWED\\n'
                        /bin/mv replacement-git .git
                    fi ;;
            unlink) if /bin/rm .git 2>/dev/null; then
                        printf 'GIT UNLINK ALLOWED\\n'
                        /bin/ln -s replacement-git .git
                    fi ;;
            replace) if /bin/mv -f replacement-git .git 2>/dev/null; then
                         printf 'GIT REPLACEMENT ALLOWED\\n'
                     fi ;;
        esac
    """, operation)
    assert "ALLOWED" not in output, output
    assert not pointer.is_symlink()
    assert pointer.read_bytes() == original
    worker.workspace.verify(worker.run)


def test_isara_launcher_policy_matches_preflight_after_cwd_restore(worker):
    # Exercise the actual launcher helpers, not `isara pi run` itself: the CLI
    # would mint an ephemeral credential even for --version. On macOS the real
    # run path uses these same provider read grants and Sandboxed._settings().
    script = """
import json
from pathlib import Path
from cli._caller_cwd import restore_caller_cwd
from cli.pi._sandbox import ISARA_PROVIDER_EXTENSION_DIR
from cave.execution.sandbox import Sandboxed, sandbox_run_env
restore_caller_cwd()
invocation = Sandboxed(cmd=['pi', '--version'], profile='locked',
                       extra_allow_read=(str(ISARA_PROVIDER_EXTENSION_DIR),),
                       linux_filesystem='apparmor')
print(json.dumps({'cwd': str(Path.cwd()), 'policy': invocation._settings(),
                  'provider': str(ISARA_PROVIDER_EXTENSION_DIR),
                  'path': sandbox_run_env(True, include_srt_debug=False)['PATH']}))
"""
    env = worker.sandbox.environment(worker.path)
    assert "ISARA_ORIGINAL_CWD" not in env
    # Emulate only the wrapper's cwd handoff, without executing its CLI/auth path.
    env["ISARA_ORIGINAL_CWD"] = str(worker.path)
    output = worker.sandbox.commands.run(
        [str(worker.config.isara_checkout / ".venv/bin/python"), "-c", script],
        cwd=worker.config.isara_checkout, env=env, timeout=30,
    )
    actual = json.loads(output)
    assert actual["cwd"] == str(worker.path)
    assert actual["provider"] == str(worker.config.provider_extension.parent)
    assert actual["policy"] == worker.policy
    assert actual["path"].split(os.pathsep)[0] == str(worker.path / ".gho/bin")
