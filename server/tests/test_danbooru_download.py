"""Integrity tests for ``DanbooruClient.download_image``.

The downloader streams into a ``.part`` temp file, verifies the byte count
against the API-reported ``file_size``, and only then atomically renames to
the final path. These tests pin the three behaviours that keep truncated
files out of the library: short bodies are retried, exhausted retries leave
nothing behind, and a retry that succeeds publishes the complete file.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING

import httpx

from danbooru import DanbooruClient, _Throttle

if TYPE_CHECKING:
    from pathlib import Path

FULL_BODY = b"x" * 1024


def _make_client(handler) -> DanbooruClient:
    client = DanbooruClient(api_key="k", user_id="u")
    client.client = httpx.Client(transport=httpx.MockTransport(handler))
    client._throttle = _Throttle(interval_min=0, interval_max=0)  # no pacing in tests
    return client


def _make_post() -> SimpleNamespace:
    return SimpleNamespace(
        id=123,
        file_url="https://cdn.example/123.jpg",
        file_ext="jpg",
        file_size=len(FULL_BODY),
    )


def test_complete_download_is_published_atomically(tmp_path: Path) -> None:
    client = _make_client(lambda _req: httpx.Response(200, content=FULL_BODY))

    assert client.download_image(_make_post(), str(tmp_path)) == "downloaded"

    final = tmp_path / "123.jpg"
    assert final.read_bytes() == FULL_BODY
    assert not (tmp_path / "123.jpg.part").exists()


def test_truncated_download_fails_and_leaves_no_file(tmp_path: Path) -> None:
    # Body shorter than the API-reported file_size on every attempt.
    client = _make_client(lambda _req: httpx.Response(200, content=FULL_BODY[:100]))

    assert client.download_image(_make_post(), str(tmp_path)) == "failed"

    # Nothing at the final path (so the next import retries it) and no
    # stale .part temp file either.
    assert list(tmp_path.iterdir()) == []


def test_truncated_then_complete_download_recovers(tmp_path: Path) -> None:
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        body = FULL_BODY[:100] if calls["n"] == 1 else FULL_BODY
        return httpx.Response(200, content=body)

    client = _make_client(handler)

    assert client.download_image(_make_post(), str(tmp_path)) == "downloaded"
    assert calls["n"] == 2
    assert (tmp_path / "123.jpg").read_bytes() == FULL_BODY
