"""All note tests use temporary vaults, never the user's Obsidian directory."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from github_orchestrator.domain import OrchestratorError, digest
from github_orchestrator.notes import Notes

URL = "https://github.com/example/repo/issues/1"
URL2 = "https://github.com/example/repo/issues/2"
NOTION_ID = "138cea45-47b4-4284-8362-f67377f236fa"


@pytest.fixture
def vault(tmp_path):
    (tmp_path / "Tasks").mkdir()
    (tmp_path / "Tasks/task.md").write_bytes(b"---\r\ntype: task\r\nstatus: Not started\r\n---\r\n# Private\r\n")
    return tmp_path


def read_registry(vault):
    return json.loads((vault / ".github-orchestrator/links.json").read_text())


def test_link_is_stable_and_only_updates_bridge(vault):
    original = (vault / "Tasks/task.md").read_bytes()
    notes = Notes(vault)
    first = notes.link("Tasks/task.md", [URL2, URL, "https://github.com/EXAMPLE/REPO/issues/1"])
    assert first["issueUrls"] == [URL, URL2]
    second = notes.link("Tasks/task.md", [URL])
    assert first["id"] == second["id"]
    assert notes.links() == [second]
    assert read_registry(vault) == {"schemaVersion": 1, "links": [second]}
    assert (vault / "Tasks/task.md").read_bytes() == original
    assert not (vault / ".github-orchestrator/lock").exists()


def test_infers_canonical_notion_id_and_preserves_link_on_rename(vault):
    path = vault / "Tasks/task.md"
    path.write_text(f"---\ntype: task\nnotion_managed: true\nnotion_page_id: {NOTION_ID.replace('-', '').upper()}\n---\n")
    notes = Notes(vault)
    first = notes.link("Tasks/task.md", [URL])
    assert first["notionPageId"] == NOTION_ID
    path.rename(vault / "Tasks/renamed.md")
    renamed = notes.link("Tasks/renamed.md", [URL2])
    assert renamed["id"] == first["id"]
    assert renamed["notePath"] == "Tasks/renamed.md"
    assert len(notes.links()) == 1


def test_request_binds_exact_issue_set_without_editing_note(vault):
    notes = Notes(vault)
    link = notes.link("Tasks/task.md", [URL, URL2])
    before = (vault / "Tasks/task.md").read_bytes()
    request = notes.request_completion(link)
    assert request["linkId"] == link["id"]
    assert request["issueUrls"] == link["issueUrls"]
    assert request["issueFingerprint"] == digest([URL, URL2])
    assert request["requestedAt"].endswith("Z")
    saved = json.loads((vault / f".github-orchestrator/requests/{request['id']}.json").read_text())
    assert saved == request
    assert (vault / "Tasks/task.md").read_bytes() == before
    # Each explicit call is a deliberate retry; receipt deduplication is per request ID.
    assert notes.request_completion(link)["id"] != request["id"]


def test_stale_completion_rejected(vault):
    notes = Notes(vault)
    old = notes.link("Tasks/task.md", [URL])
    notes.link("Tasks/task.md", [URL2])
    with pytest.raises(OrchestratorError, match="changed"):
        notes.request_completion(old)
    assert not (vault / ".github-orchestrator/requests").exists()


@pytest.mark.parametrize("path", [
    "../outside.md", "/tmp/task.md", "Tasks/../task.md", "Tasks//task.md", "./Tasks/task.md",
    "Tasks\\task.md", "C:/task.md", ".obsidian/task.md", "Tasks/.hidden.md", "Tasks/task.txt",
    "Tasks/task.md\n", "", None,
])
def test_invalid_paths_rejected(vault, path):
    with pytest.raises(OrchestratorError):
        Notes(vault).link(path, [URL])


@pytest.mark.parametrize("urls", [[], ["https://evil.example/issue/1"], ["https://github.com/o/r/pull/1"], [None], None])
def test_invalid_issue_sets_rejected(vault, urls):
    with pytest.raises(OrchestratorError):
        Notes(vault).link("Tasks/task.md", urls)


@pytest.mark.parametrize("text", [
    "# Not a task\n", "---\ntype: memo\n---\n", "---\ntype: task\n",
    "---\ntype: task\nnotion_managed: true\n---\n",
    "---\ntype: task\nnotion_page_id: bad\n---\n",
    "---\ntype: !!python/object/apply:os.system ['false']\n---\n",
    "---\ntype: task\na: &a [1]\nb: *a\n---\n",
])
def test_frontmatter_must_be_safe_task_metadata(vault, text):
    (vault / "Tasks/task.md").write_text(text)
    with pytest.raises(OrchestratorError):
        Notes(vault).link("Tasks/task.md", [URL])


@pytest.mark.parametrize("target", ["note", "parent", "bridge", "registry", "requests", "lock"])
def test_symlinks_rejected(vault, tmp_path_factory, target):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "task.md").write_text("---\ntype: task\n---\n")
    notes = Notes(vault)
    if target == "note":
        (vault / "Tasks/task.md").unlink()
        (vault / "Tasks/task.md").symlink_to(outside / "task.md")
    elif target == "parent":
        (vault / "Tasks/task.md").unlink()
        (vault / "Tasks").rmdir()
        (vault / "Tasks").symlink_to(outside, target_is_directory=True)
    elif target == "bridge":
        (vault / ".github-orchestrator").symlink_to(outside, target_is_directory=True)
    else:
        link = notes.link("Tasks/task.md", [URL])
        path = vault / ".github-orchestrator" / ("links.json" if target == "registry" else target)
        path.unlink(missing_ok=True)
        path.symlink_to(outside / "missing" if target == "registry" else outside)
        with pytest.raises(OrchestratorError, match="symlink"):
            notes.request_completion(link)
        return
    with pytest.raises(OrchestratorError, match="symlink"):
        notes.link("Tasks/task.md", [URL])


def test_parallel_updates_do_not_lose_associations(vault):
    for index in range(12):
        (vault / f"Tasks/{index}.md").write_text("---\ntype: task\n---\n")
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda index: Notes(vault).link(f"Tasks/{index}.md", [URL]), range(12)))
    assert {link["id"] for link in Notes(vault).links()} == {link["id"] for link in results}
    assert not list((vault / ".github-orchestrator").glob("*.tmp"))


def test_corrupt_registry_is_not_overwritten(vault):
    notes = Notes(vault)
    notes.link("Tasks/task.md", [URL])
    path = vault / ".github-orchestrator/links.json"
    path.write_text('{"schemaVersion": 99, "links": []}')
    with pytest.raises(OrchestratorError):
        notes.link("Tasks/task.md", [URL2])
    assert json.loads(path.read_text())["schemaVersion"] == 99


def test_path_identity_cannot_be_reassigned_silently(vault):
    notes = Notes(vault)
    notes.link("Tasks/task.md", [URL])
    (vault / "Tasks/task.md").write_text(f"---\ntype: task\nnotion_page_id: {NOTION_ID}\n---\n")
    with pytest.raises(OrchestratorError, match="identity changed"):
        notes.link("Tasks/task.md", [URL2])


def test_unknown_vault_rejected(tmp_path):
    with pytest.raises(OrchestratorError):
        Notes(tmp_path / "missing")


def test_add_unions_and_repeat_adds_preserve_identity(vault):
    notes = Notes(vault)
    before = (vault / "Tasks/task.md").read_bytes()
    first = notes.add("Tasks/task.md", [URL2])
    added = notes.add("Tasks/task.md", [URL, "https://github.com/EXAMPLE/REPO/issues/2"])
    assert added["id"] == first["id"]
    assert added["issueUrls"] == [URL, URL2]
    assert notes.add("Tasks/task.md", [URL]) == added
    assert notes.link("Tasks/task.md", [URL])["issueUrls"] == [URL], "link still replaces the whole set"
    assert (vault / "Tasks/task.md").read_bytes() == before


def test_add_uses_canonical_notion_identity_after_rename(vault):
    path = vault / "Tasks/task.md"
    path.write_text(f"---\ntype: task\nnotion_page_id: {NOTION_ID.replace('-', '').upper()}\n---\n")
    notes = Notes(vault)
    first = notes.add("Tasks/task.md", [URL])
    path.rename(vault / "Tasks/renamed.md")
    (vault / "Tasks/renamed.md").write_text(f"---\ntype: task\nnotion_page_id: {NOTION_ID}\n---\n")
    added = notes.add("Tasks/renamed.md", [URL2])
    assert added == {**first, "notePath": "Tasks/renamed.md", "issueUrls": [URL, URL2]}
    assert notes.add("Tasks/renamed.md", [URL2]) == added
    assert notes.links() == [added]


def test_add_rejects_identity_change(vault):
    notes = Notes(vault)
    first = notes.add("Tasks/task.md", [URL])
    (vault / "Tasks/task.md").write_text(f"---\ntype: task\nnotion_page_id: {NOTION_ID}\n---\n")
    with pytest.raises(OrchestratorError, match="identity changed"):
        notes.add("Tasks/task.md", [URL2])
    assert notes.links() == [first]


def test_parallel_adds_do_not_lose_issues(vault):
    urls = [f"https://github.com/example/repo/issues/{index}" for index in range(1, 13)]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda url: Notes(vault).add("Tasks/task.md", [url]), urls))
    links = Notes(vault).links()
    assert len(links) == 1
    assert links[0]["issueUrls"] == sorted(urls)
    assert {item["id"] for item in results} == {links[0]["id"]}


def write_receipt(vault, request, status):
    path = vault / ".github-orchestrator/receipts" / f"{request['id']}.json"
    path.parent.mkdir(exist_ok=True)
    receipt = {
        "schemaVersion": 1, "requestId": request["id"], "linkId": request["linkId"],
        "issueFingerprint": request["issueFingerprint"], "status": status,
        "recordedAt": datetime.now(UTC).isoformat(), "notionConfirmed": False,
    }
    path.write_text(json.dumps(receipt))
    return receipt


def age_request(vault, request, days):
    request = {**request, "requestedAt": (datetime.now(UTC) - timedelta(days=days)).isoformat()}
    (vault / f".github-orchestrator/requests/{request['id']}.json").write_text(json.dumps(request))
    return request


def test_completion_state_none_pending_and_exact_issue_set(vault):
    notes = Notes(vault)
    link = notes.link("Tasks/task.md", [URL])
    assert notes.completion_state(link) is None
    request = notes.request_completion(link)
    assert notes.completion_state(link) == {
        "status": "pending", "requestId": request["id"], "requestedAt": request["requestedAt"],
        "issueFingerprint": request["issueFingerprint"], "receipt": None,
    }
    updated = notes.add("Tasks/task.md", [URL2])
    assert notes.completion_state(updated) is None
    with pytest.raises(OrchestratorError, match="changed"):
        notes.completion_state(link)


@pytest.mark.parametrize("status", [
    "processing", "local-accepted", "already-done", "failed", "api-unavailable", "stale", "rolled-back", "interrupted",
])
def test_completion_state_returns_latest_receipt(vault, status):
    notes = Notes(vault)
    link = notes.link("Tasks/task.md", [URL])
    older = age_request(vault, notes.request_completion(link), days=1)
    write_receipt(vault, older, "local-accepted")
    newer = notes.request_completion(link)
    receipt = write_receipt(vault, newer, status)
    state = notes.completion_state(link)
    assert state["requestId"] == newer["id"]
    assert state["status"] == status
    assert state["receipt"] == receipt


def test_completion_state_expires_only_unprocessed_requests(vault):
    notes = Notes(vault)
    link = notes.link("Tasks/task.md", [URL])
    request = age_request(vault, notes.request_completion(link), days=2)
    state = notes.completion_state(link)
    assert state["status"] == "stale"
    assert state["receipt"] is None
    write_receipt(vault, request, "local-accepted")
    assert notes.completion_state(link)["status"] == "local-accepted"


def test_completion_state_checks_receipt_identity(vault):
    notes = Notes(vault)
    link = notes.link("Tasks/task.md", [URL])
    request = notes.request_completion(link)
    invalid = {**write_receipt(vault, request, "local-accepted"), "issueFingerprint": "different"}
    (vault / f".github-orchestrator/receipts/{request['id']}.json").write_text(json.dumps(invalid))
    with pytest.raises(OrchestratorError, match="receipt identity"):
        notes.completion_state(link)


def test_completion_state_rejects_receipt_symlink(vault, tmp_path_factory):
    notes = Notes(vault)
    link = notes.link("Tasks/task.md", [URL])
    notes.request_completion(link)
    (vault / ".github-orchestrator/receipts").symlink_to(tmp_path_factory.mktemp("receipts"))
    with pytest.raises(OrchestratorError, match="symlink"):
        notes.completion_state(link)
