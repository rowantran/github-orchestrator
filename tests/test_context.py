import hashlib
import json
import shutil
from dataclasses import replace

import pytest
from test_runner import issue
from test_runner import runner as runner

from github_orchestrator import context
from github_orchestrator.domain import OrchestratorError, digest


@pytest.fixture
def assets(tmp_path, monkeypatch):
    resources, extension = tmp_path / "resources", tmp_path / "pi"
    shutil.copytree(context.asset_root(), resources)
    extension.mkdir()
    for path in context.extension_path().parent.glob("*.ts"):
        shutil.copy2(path, extension / path.name)
    monkeypatch.setattr(context, "asset_root", lambda: resources)
    monkeypatch.setattr(context, "extension_path", lambda: extension / "worker.ts")
    return resources, extension


def test_render_is_single_pass_and_does_not_interpret_task_braces():
    text = '{{branch}} {python_dict} ${shell} {{unknown}}'
    assert context.render("{{issue_body}} / {{branch}}", {"issue_body": text, "branch": "safe"}) == text + " / safe"
    with pytest.raises(OrchestratorError, match="a, z"):
        context.render("{{z}} {{a}}", {})


def test_resource_headers_are_required_and_stripped_once(assets):
    resources, _ = assets
    (resources / "test.md").write_text("<!-- Purpose: test. Audience: tests. Injection: none. -->\nBody <!-- keep -->")
    (resources / "test.json").write_text('{"_purpose": "test", "value": {"_purpose": "keep"}}')
    assert context.text_resource("test.md") == "Body <!-- keep -->"
    assert context.json_resource("test.json") == {"value": {"_purpose": "keep"}}
    for name, text in (("test.md", "No header"), ("test.json", '{}'), ("test.json", '[]')):
        (resources / name).write_text(text)
        with pytest.raises(OrchestratorError, match="purpose"):
            (context.json_resource if name.endswith("json") else context.text_resource)(name)


def test_bootstrap_uses_last_literal_version_without_executing_code(tmp_path):
    path = tmp_path / "src/cli/agent_bootstrap_prompt.py"
    path.parent.mkdir(parents=True)
    path.write_text('raise RuntimeError("must not execute")\n'
                    'AGENT_BOOTSTRAP_PROMPT_VERSIONS: tuple = (Version(prompt="old"), Version(prompt="new"))\n')
    assert context.bootstrap_prompt(tmp_path) == "new"
    for value in ('Version(prompt=load_secret())', 'Version(prompt="")', '"not a version"'):
        path.write_text(f"AGENT_BOOTSTRAP_PROMPT_VERSIONS: tuple = ({value},)\n")
        with pytest.raises(OrchestratorError, match="statically inspect"):
            context.bootstrap_prompt(tmp_path)


@pytest.mark.parametrize("change", ["resource", "extension", "bootstrap", "provider", "project", "guidance"])
def test_artifact_hashes_invalidate_fingerprint_but_base_alone_does_not(runner, assets, monkeypatch, change):
    builder = runner.context
    before = builder.snapshot(issue(), "base-a")
    assert digest(before) == digest(builder.snapshot(issue(), "base-b"))
    resources, extension = assets
    for key, root in (("resource_hashes", resources), ("extension_hashes", extension)):
        assert before[key]
        for name, checksum in before[key].items():
            assert checksum == hashlib.sha256((root / name).read_bytes()).hexdigest()
    if change in {"resource", "extension"}:
        path = resources / "worker-task.md" if change == "resource" else extension / "worker.ts"
        path.write_text(path.read_text() + "\nchanged\n")
    elif change == "bootstrap":
        monkeypatch.setattr(context, "bootstrap_prompt", lambda _: "changed bootstrap")
    elif change == "guidance":
        runner.workspace.context = "changed guidance"
    else:
        field = "provider_extension" if change == "provider" else "project_id"
        value = extension / "other.ts" if change == "provider" else "PVT_other"
        builder.config = replace(builder.config, **{field: value})
    assert digest(before) != digest(builder.snapshot(issue(), "base-a"))


def test_provider_contents_and_sandbox_paths_are_approval_bound(runner):
    provider = runner.config.provider_extension
    provider.write_text("export default function () {}")
    before = runner.context.snapshot(issue(), "base-a")
    provider.write_text("export default function changed () {}")
    after = runner.context.snapshot(issue(), "base-a")
    assert before["provider_hashes"] != after["provider_hashes"]
    assert digest(before) != digest(after)
    runner.context.config = replace(runner.config, workspace_dir=runner.config.workspace_dir / "other")
    moved = runner.context.snapshot(issue(), "base-a")
    assert after["sandbox_override"] != moved["sandbox_override"]
    assert digest(after) != digest(moved)


def test_bundle_freezes_inputs_and_copies_review_layout(runner, assets, tmp_path):
    builder = runner.context
    snapshot = builder.snapshot(issue(body="{{branch}} is literal task data"), "base-a")
    bundle = builder.bundle(snapshot, run_id="run-1", branch="owner/task", base_commit="base-a")
    assert "{{branch}} is literal task data" in bundle["task.md"]
    assert "<!-- Purpose:" not in bundle["system.md"]
    assert json.loads(bundle["approval.json"]) == {"fingerprint": digest(snapshot), "snapshot": snapshot}
    assert json.loads(bundle["context.json"])["base_commit"] == "base-a"
    assert {"pi/worker.ts", "pi/context.ts", "pi/resources.ts", "agent-context/tool-definitions.json"} <= bundle.keys()
    assert not any(name.endswith(".test.ts") for name in bundle)
    assert "_purpose" not in json.loads(bundle["tool-definitions.json"])
    (assets[1] / "worker.ts").write_text("changed after freezing")
    for directory in (tmp_path / "worktree/.gho/input", tmp_path / "attempts/run-1/input"):
        builder.write_bundle(directory, bundle)
        assert directory.stat().st_mode & 0o777 == 0o700
        for name, text in bundle.items():
            assert (directory / name).read_text() == text
            assert (directory / name).stat().st_mode & 0o777 == 0o600
        with pytest.raises(OrchestratorError, match="existing context"):
            builder.write_bundle(directory, bundle)


def test_snapshot_refuses_oversized_context_without_truncation(runner):
    runner.workspace.context = "é" * context.MAX_CONTEXT_BYTES
    with pytest.raises(OrchestratorError, match="128 KiB.*nothing was truncated"):
        runner.context.snapshot(issue(), "base-a")


def test_bundle_rejects_unsafe_paths_and_symlink_directory(runner, tmp_path):
    for name in ("../escaped", str(tmp_path / "absolute")):
        with pytest.raises(OrchestratorError, match="Invalid context bundle path"):
            runner.context.write_bundle(tmp_path / "input", {name: "unsafe"})
    (tmp_path / "linked").symlink_to(tmp_path / "input", target_is_directory=True)
    with pytest.raises(OrchestratorError, match="symlink"):
        runner.context.write_bundle(tmp_path / "linked", {"task.md": "unsafe"})
    assert not (tmp_path / "escaped").exists()
