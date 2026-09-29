"""A locked Isara profile with task-local writes and a task-local Pi home.

The policy lives in our managed clone, never in the user's source checkout.
We resolve it through Isara itself and probe the real OS sandbox before running Pi.
"""

from __future__ import annotations

import json
import os
import platform
import shlex
import shutil
from pathlib import Path

from .config import Config, extension_path
from .domain import OrchestratorError
from .process import Commands


class Sandbox:
    def __init__(self, config: Config, commands: Commands | None = None):
        self.config = config
        self.commands = commands or Commands()

    def policy(self) -> dict:
        c = self.config
        return {
            "network": {"allowAllDomains": True},
            "filesystem": {
                # Relative '.' is resolved by srt against EACH worktree, not the clone.
                "allowWrite": ["."],
                "allowRead": [str(c.clone / ".git"), str(c.provider_extension.parent)],
                # Concrete relative paths also match hidden directories. srt's glob
                # expansion can skip .gho, so globs are not a safe protection here.
                "denyWrite": [str(c.clone), str(c.state_dir), ".gho/input", ".gho/bin", ".git"],
                "allowGitConfig": False,
            },
        }

    def install_policy(self) -> None:
        path = self.config.clone / "security_profile.json"
        expected = json.dumps(self.policy(), indent=2) + "\n"
        if path.is_symlink():
            raise OrchestratorError("Managed sandbox policy cannot be a symlink.")
        if path.exists() and path.read_text() != expected:
            raise OrchestratorError("Managed sandbox policy changed. Review it; do not silently overwrite it.")
        if not path.exists():
            with path.open("x") as handle:
                handle.write(expected)
            path.chmod(0o600)

    def prerequisites(self) -> None:
        # Linux AppArmor preparation is interactive and per-checkout. Do not silently downgrade it.
        if platform.system() != "Darwin":
            raise OrchestratorError("Worker launch currently supports macOS Seatbelt only. Linux needs a tested AppArmor adapter.")
        for executable in ("srt", "isara", "pi", "wt"):
            if not shutil.which(self.config.executable(executable)):
                raise OrchestratorError(f"Install {executable} before worker launch; unsandboxed fallback is forbidden.")
        if not self.config.provider_extension.is_file() or not extension_path().is_file():
            raise OrchestratorError("Pi provider/worker extension not found. Check worker configuration.")
        if not (self.config.isara_checkout / ".venv/bin/python").is_file():
            raise OrchestratorError("Isara's .venv/bin/python is required to inspect the actual resolved sandbox policy.")
        version = self.commands.run([self.config.executable("pi"), "--version"]).strip()
        if version != "0.87.1":
            raise OrchestratorError(f"Pi {version} has not been qualified. This release requires Pi 0.87.1.")

    def resolve(self, worktree: Path) -> dict:
        # Fixed code, never composed from issue text. Isara's trusted Python package owns resolution.
        script = (
            "import json; from cave.execution.sandbox import resolve_profile; "
            "from cli.pi._sandbox import ISARA_PROVIDER_EXTENSION_DIR; "
            "print(json.dumps(resolve_profile('locked', extra_allow_read=(str(ISARA_PROVIDER_EXTENSION_DIR),))))"
        )
        raw = self.commands.run([str(self.config.isara_checkout / ".venv/bin/python"), "-c", script], cwd=worktree)
        try:
            policy = json.loads(raw)
        except ValueError as exc:
            raise OrchestratorError("Isara did not return a readable sandbox policy.") from exc
        writes = policy.get("filesystem", {}).get("allowWrite")
        if writes != ["."]:
            raise OrchestratorError(f"Unexpected Isara write grants: {writes!r}; refusing launch.")
        network = policy.get("network", {})
        if network.get("allowUnixSockets") or network.get("allowMachLookup"):
            raise OrchestratorError("Worker policy must not expose host sockets or keychain services.")
        if str(Path.home()) not in policy.get("filesystem", {}).get("denyRead", []):
            raise OrchestratorError("Locked policy no longer denies ambient home-directory reads.")
        return policy

    def prepare(self, worktree: Path) -> dict:
        self.prerequisites()
        self.install_policy()
        control = worktree / ".gho"
        if control.is_symlink():
            raise OrchestratorError("Worker control directory is a symlink.")
        for child in ("input", "bin", "home", "tmp", "sessions"):
            (control / child).mkdir(parents=True, exist_ok=True, mode=0o700)
        real_pi = shutil.which(self.config.executable("pi"))
        assert real_pi is not None
        # Isara intentionally scrubs PI_* vars. Set the isolated home INSIDE its sandbox,
        # after credentials have been minted, before the real Pi executable is started.
        quote = shlex.quote
        shim = (
            "#!/bin/sh\nset -eu\n"
            f"export HOME={quote(str(control / 'home'))}\n"
            f"export PI_CODING_AGENT_DIR={quote(str(control / 'home/.pi/agent'))}\n"
            f"export XDG_CONFIG_HOME={quote(str(control / 'home/.config'))}\n"
            f"export XDG_CACHE_HOME={quote(str(control / 'home/.cache'))}\n"
            f"export TMPDIR={quote(str(control / 'tmp'))}\n"
            f"exec {quote(real_pi)} \"$@\"\n"
        )
        (control / "bin/pi").write_text(shim)
        (control / "bin/pi").chmod(0o700)
        policy = self.resolve(worktree)
        (control / "input/resolved-sandbox.json").write_text(json.dumps(policy, indent=2) + "\n")
        self.probe(worktree, policy)
        return policy

    def probe(self, worktree: Path, policy: dict) -> None:
        """No credentials or model call: prove writes work locally and host state is denied."""
        secret = self.config.state_dir / "sandbox-probe"
        secret.write_text("sandbox probe; not a credential\n")
        policy_path = worktree / ".gho/input/resolved-sandbox.json"
        if not policy_path.exists():
            policy_path.parent.mkdir(parents=True, exist_ok=True)
            policy_path.write_text(json.dumps(policy))
        script = (
            'set -eu; test ! -r "$1"; '
            'if (echo forbidden >> "$1") 2>/dev/null; then exit 40; fi; '
            'if (echo forbidden >> "$2") 2>/dev/null; then exit 41; fi; '
            'if (echo forbidden >> "$3") 2>/dev/null; then exit 42; fi; '
            'echo allowed > .gho/probe-output; rm .gho/probe-output'
        )
        self.commands.run([self.config.executable("srt"), "--settings", str(policy_path), "--",
                           "/bin/sh", "-c", script, "gho-probe", str(secret),
                           str(self.config.clone / "security_profile.json"), str(policy_path)],
                          cwd=worktree, timeout=30)

    def environment(self, worktree: Path) -> dict[str, str]:
        env = dict(os.environ)
        # Never let a stale wrapper override the worktree cwd.
        env.pop("ISARA_ORIGINAL_CWD", None)
        env["PATH"] = str(worktree / ".gho/bin") + os.pathsep + env.get("PATH", "")
        return env
