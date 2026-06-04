"""HTTP-level tests for DELETE /v2/folders/{folder_path}.

Runs the real FoldersController through a Litestar ``TestClient`` against the
seeded DB fixture (see conftest) plus a matching on-disk tree, and pins:

    folder delete removes the subtree's posts (DB) and files (disk)
    sibling / parent folders survive untouched
    the library root and paths escaping it are refused
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from litestar import Litestar, Router
from litestar.plugins.pydantic import PydanticPlugin
from litestar.testing import TestClient

import shared
from server.dependencies import REQUEST_DEPENDENCIES
from server.exceptions import DomainError, domain_error_handler
from server.folders import FoldersController

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from db.connection import DB

# Disk layout mirroring the conftest post seed (photos/a.jpg, photos/b.png,
# photos/sub/c.jpg, art/d.webp, art/e.jpg).
_SEED_FILES = ["photos/a.jpg", "photos/b.png", "photos/sub/c.jpg", "art/d.webp", "art/e.jpg"]


@pytest.fixture
def api_client(db: DB, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(shared, "target_dir", tmp_path)
    monkeypatch.setattr(shared, "pictoria_dir", tmp_path / ".pictoria")
    monkeypatch.setattr(shared, "thumbnails_dir", tmp_path / ".pictoria" / "thumbnails")
    for rel in _SEED_FILES:
        f = tmp_path / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"\x89PNG")
        thumb = shared.thumbnails_dir / rel
        thumb.parent.mkdir(parents=True, exist_ok=True)
        thumb.write_bytes(b"\x89PNG")

    app = Litestar(
        route_handlers=[Router("/v2", route_handlers=[FoldersController])],
        dependencies=REQUEST_DEPENDENCIES,
        exception_handlers={DomainError: domain_error_handler},
        plugins=[PydanticPlugin(prefer_alias=True)],
        on_app_init=None,
    )
    app.state.db = db
    with TestClient(app=app) as client:
        yield client


def _remaining_ids(db: DB) -> set[int]:
    cur = db.cursor()
    cur.execute("SELECT id FROM posts")
    return {r[0] for r in cur.fetchall()}


def test_delete_folder_removes_subtree_posts_and_files(api_client: TestClient, db: DB, tmp_path: Path) -> None:
    resp = api_client.delete("/v2/folders/photos")
    assert resp.status_code == 200
    assert "3 posts" in resp.json()["msg"]
    # posts 1/2 (photos) and 3 (photos/sub) are gone; art's 4/5 survive
    assert _remaining_ids(db) == {4, 5}
    assert not (tmp_path / "photos").exists()
    assert not (shared.thumbnails_dir / "photos").exists()
    assert (tmp_path / "art" / "d.webp").exists()


def test_delete_subfolder_keeps_parent(api_client: TestClient, db: DB, tmp_path: Path) -> None:
    resp = api_client.delete("/v2/folders/photos/sub")
    assert resp.status_code == 200
    assert "1 posts" in resp.json()["msg"]
    assert _remaining_ids(db) == {1, 2, 4, 5}
    assert (tmp_path / "photos" / "a.jpg").exists()
    assert not (tmp_path / "photos" / "sub").exists()


def test_delete_empty_folder(api_client: TestClient, tmp_path: Path) -> None:
    # A folder with no posts (and no files) still deletes cleanly — the DB
    # pass is a no-op and only the rmtree does work.
    (tmp_path / "empty").mkdir()
    resp = api_client.delete("/v2/folders/empty")
    assert resp.status_code == 200
    assert "0 posts" in resp.json()["msg"]
    assert not (tmp_path / "empty").exists()


def test_delete_refuses_root(api_client: TestClient, db: DB) -> None:
    resp = api_client.delete("/v2/folders/@")
    assert resp.status_code == 400
    assert _remaining_ids(db) == {1, 2, 3, 4, 5}


def test_delete_refuses_path_escaping_library(api_client: TestClient, db: DB, tmp_path: Path) -> None:
    # %2e%2e survives the client's URL normalisation; the server decodes it
    # back to "photos/../.." which resolves outside the library root.
    resp = api_client.delete("/v2/folders/photos/%2e%2e/%2e%2e")
    assert resp.status_code == 400
    assert _remaining_ids(db) == {1, 2, 3, 4, 5}
    assert (tmp_path / "photos" / "a.jpg").exists()


def test_delete_missing_folder_404(api_client: TestClient) -> None:
    assert api_client.delete("/v2/folders/nope").status_code == 404
