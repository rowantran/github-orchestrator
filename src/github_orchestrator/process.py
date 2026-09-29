"""Argument-array subprocesses. No shell evaluation and no credential extraction."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Mapping, Sequence

from .domain import OrchestratorError


class CommandError(OrchestratorError):
    def __init__(self, argv: Sequence[str], returncode: int, stderr: str):
        self.argv, self.returncode, self.stderr = list(argv), returncode, stderr
        super().__init__(f"{Path(argv[0]).name} exited {returncode}: {stderr.strip()[-3000:]}")


class Commands:
    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | None = None,
        input: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float = 60,
    ) -> str:
        environment = dict(os.environ if env is None else env)
        environment.update({"GH_PROMPT_DISABLED": "1", "GIT_TERMINAL_PROMPT": "0", "NO_COLOR": "1"})
        try:
            result = subprocess.run(
                list(argv), cwd=cwd, input=input, text=True, capture_output=True,
                env=environment, timeout=timeout, check=False,
            )
        except FileNotFoundError as exc:
            raise OrchestratorError(f"Required executable not found: {argv[0]}") from exc
        except subprocess.TimeoutExpired as exc:
            raise OrchestratorError(f"{Path(argv[0]).name} timed out after {timeout:g}s; no success assumed.") from exc
        if result.returncode:
            raise CommandError(argv, result.returncode, result.stderr)
        return result.stdout
