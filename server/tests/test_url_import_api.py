"""HTTP-level tests for the gallery-dl URL import command endpoints.

Pin the POST /v2/cmd/import-from-url + GET /v2/cmd/import-from-url/status
state machine through a real Litestar ``TestClient``. The actual gallery-dl
fetch (``services.gallery_dl_import.import_from_url``) and the post-import
sync-metadata trigger are monkeypatched so no subprocess / network / ML stack
is touched — these tests cover only the task lifecycle:

    idle -> running -> done(stats, sync triggered)
                    -> failed(error, no sync)
    running rejects a second POST
"""

from __future__ import annotations

import asyncio
import threading
import time
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

import pytest
from litestar import Litestar, Router
from litestar.plugins.pydantic import PydanticPlugin
from litestar.testing import TestClient

import server.commands as commands_module
import shared
from scheme import UrlImportStatus
from server.commands import CommandController
from server.dependencies import REQUEST_DEPENDENCIES
from server.exceptions import DomainError, domain_error_handler
from services.gallery_dl_import import GalleryDLStats

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from db.connection import DB

URL = "https://kemono.cr/patreon/user/177539829"
POLL_DEADLINE = 10.0


@pytest.fixture
def api_client(db: DB, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(shared, "target_dir", tmp_path)

    @asynccontextmanager
    async def _lifespan(app: Litestar):
        app.state.db = db
        app.state.background_tasks = set()
        app.state.backfill_lock = asyncio.Lock()
        app.state.canonical_tag_groups = {"artist": 1, "general": 2}
        app.state.url_import_status = UrlImportStatus()
        yield

    app = Litestar(
        route_handlers=[Router("/v2", route_handlers=[CommandController])],
        dependencies=REQUEST_DEPENDENCIES,
        exception_handlers={DomainError: domain_error_handler},
        plugins=[PydanticPlugin(prefer_alias=True)],
        lifespan=[_lifespan],
    )
    with TestClient(app=app) as client:
        yield client


def _poll_until_settled(client: TestClient) -> dict[str, Any]:
    deadline = time.monotonic() + POLL_DEADLINE
    while time.monotonic() < deadline:
        body = client.get("/v2/cmd/import-from-url/status").json()
        if body["state"] in {"done", "failed"}:
            return body
        time.sleep(0.05)
    msg = f"import never settled within {POLL_DEADLINE}s: {body}"
    raise AssertionError(msg)


def test_status_starts_idle(api_client: TestClient) -> None:
    resp = api_client.get("/v2/cmd/import-from-url/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "idle"
    assert body["url"] is None
    assert body["stats"] is None
    assert body["error"] is None
    assert body["syncTriggered"] is False


def test_import_runs_to_done_with_stats_and_triggers_sync(
    api_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sync_calls: list[Any] = []
    monkeypatch.setattr(
        commands_module,
        "run_url_import",
        lambda url, **kwargs: GalleryDLStats(fetched=10, images=8, new=5, downloaded=4, failed=1),
        raising=False,
    )
    monkeypatch.setattr(
        commands_module,
        "_spawn_sync_metadata",
        lambda state: sync_calls.append(state) or True,
        raising=False,
    )

    resp = api_client.post("/v2/cmd/import-from-url", params={"url": URL})
    assert resp.status_code == 201
    assert resp.json()["msg"] == "Import started"

    body = _poll_until_settled(api_client)
    assert body["state"] == "done"
    assert body["url"] == URL
    assert body["stats"] == {"fetched": 10, "images": 8, "new": 5, "downloaded": 4, "failed": 1}
    assert body["error"] is None
    assert body["startedAt"] is not None
    assert body["finishedAt"] is not None
    assert body["syncTriggered"] is True
    assert len(sync_calls) == 1


def test_second_post_while_running_is_rejected(
    api_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()

    def _blocking_import(url: str, **kwargs: Any) -> GalleryDLStats:
        release.wait(timeout=POLL_DEADLINE)
        return GalleryDLStats(fetched=1, images=1, new=0, downloaded=0, failed=0)

    monkeypatch.setattr(commands_module, "run_url_import", _blocking_import, raising=False)
    monkeypatch.setattr(commands_module, "_spawn_sync_metadata", lambda state: True, raising=False)

    first = api_client.post("/v2/cmd/import-from-url", params={"url": URL})
    assert first.json()["msg"] == "Import started"

    second = api_client.post("/v2/cmd/import-from-url", params={"url": URL})
    assert second.json()["msg"] == "Import already running"

    release.set()
    body = _poll_until_settled(api_client)
    assert body["state"] == "done"


def test_failed_import_reports_error_and_skips_sync(
    api_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sync_calls: list[Any] = []

    def _exploding_import(url: str, **kwargs: Any) -> GalleryDLStats:
        msg = "boom: gallery-dl exploded"
        raise ValueError(msg)

    monkeypatch.setattr(commands_module, "run_url_import", _exploding_import, raising=False)
    monkeypatch.setattr(
        commands_module,
        "_spawn_sync_metadata",
        lambda state: sync_calls.append(state) or True,
        raising=False,
    )

    resp = api_client.post("/v2/cmd/import-from-url", params={"url": URL})
    assert resp.json()["msg"] == "Import started"

    body = _poll_until_settled(api_client)
    assert body["state"] == "failed"
    assert "boom: gallery-dl exploded" in body["error"]
    assert body["stats"] is None
    assert body["syncTriggered"] is False
    assert not sync_calls

    # A failed run releases the slot: the next POST is accepted again.
    monkeypatch.setattr(
        commands_module,
        "run_url_import",
        lambda url, **kwargs: GalleryDLStats(fetched=2, images=2, new=2, downloaded=2, failed=0),
        raising=False,
    )
    retry = api_client.post("/v2/cmd/import-from-url", params={"url": URL})
    assert retry.json()["msg"] == "Import started"
    assert _poll_until_settled(api_client)["state"] == "done"
