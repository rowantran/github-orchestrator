#!/usr/bin/env python3
"""Permit dashboard operations only, always against this test's private tmux socket."""
import json
import os
from pathlib import Path
import re
import sys

root = Path(os.environ["GHO_E2E_FIXTURE"])
args = sys.argv[1:]
with (root / "tmux-calls.jsonl").open("a") as stream:
    stream.write(json.dumps(args) + "\n")
allowed = (
    len(args) == 5 and args[:2] == ["-N", "list-panes"]
    and args[2] in ("-a", "-s") and args[3] == "-F"
    and "#{pane_id}" in args[4]
) or (
    len(args) == 4 and args[:3] == ["-N", "select-pane", "-t"]
    and re.fullmatch(r"%\d+", args[3])
) or (
    len(args) == 4 and args[:3] == ["-N", "select-window", "-t"]
    and re.fullmatch(r"\$\d+:@\d+", args[3])
)
if not allowed:
    with (root / "rejected.jsonl").open("a") as stream:
        stream.write(json.dumps({"tmux": args}) + "\n")
    print("Rejected unexpected tmux command", file=sys.stderr)
    sys.exit(87)
if os.environ.get("GHO_E2E_TMUX_MODE") == "fake":
    # Some sandboxes prohibit Unix sockets. Keep browser/API coverage with an
    # explicit file-backed adapter, never fall back to the user's tmux server.
    path = root / "tmux-state.json"
    state = json.loads(path.read_text())
    if args[1] == "list-panes":
        for pane in state["panes"]:
            print("\t".join([pane["id"], "$0", "@0", "0", "gho-e2e", "implementer",
                             pane["path"], "acme/app", str(pane["issue"])]))
    elif args[1] == "select-pane" and any(pane["id"] == args[3] for pane in state["panes"]):
        state["active"] = args[3]
        temporary = path.with_suffix(".new")
        temporary.write_text(json.dumps(state))
        temporary.replace(path)
    elif args[1] != "select-window" or args[3] != "$0:@0":
        with (root / "rejected.jsonl").open("a") as stream:
            stream.write(json.dumps({"tmux": args, "error": "unknown fake target"}) + "\n")
        sys.exit(87)
    sys.exit(0)

# -S overrides every default/inherited socket; the wrapper cannot touch user tmux.
real = os.environ["GHO_E2E_REAL_TMUX"]
os.execv(real, [real, "-S", str(root / "tmux.sock"), *args])
