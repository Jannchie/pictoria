"""HTTP-level regression test for thumbnail generation on undecodable images.

A 0-byte (or otherwise corrupt) original file used to bubble PIL's
``UnidentifiedImageError`` out of the thumbnail endpoint as an unhandled 500.
It must instead surface as a 404 — a file PIL cannot decode has no thumbnail
to serve, which is a "not found" condition, not a server fault.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from litestar import Litestar, Router
from litestar.testing import TestClient
from PIL import Image

import shared
from server.images import ImageController

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path


@pytest.fixture
def image_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    images_dir = tmp_path / "images"
    thumbs_dir = tmp_path / "thumbnails"
    images_dir.mkdir()
    thumbs_dir.mkdir()
    monkeypatch.setattr(shared, "target_dir", images_dir)
    monkeypatch.setattr(shared, "thumbnails_dir", thumbs_dir)

    app = Litestar(route_handlers=[Router("/v2", route_handlers=[ImageController])])
    with TestClient(app=app, raise_server_exceptions=False) as client:
        yield client


def test_thumbnail_for_corrupt_image_returns_404(image_client: TestClient) -> None:
    corrupt = shared.target_dir / "danbooru" / "corrupt.jpg"
    corrupt.parent.mkdir(parents=True, exist_ok=True)
    corrupt.touch()  # 0-byte download remnant PIL cannot decode
    resp = image_client.get("/v2/images/thumbnails/danbooru/corrupt.jpg")
    assert resp.status_code == 404


def test_thumbnail_for_valid_image_succeeds(image_client: TestClient) -> None:
    valid = shared.target_dir / "ok.png"
    Image.new("RGB", (640, 480), "red").save(valid)
    resp = image_client.get("/v2/images/thumbnails/ok.png")
    assert resp.status_code == 200
