"""Unit tests for the gallery-dl import workflow's pure pieces + orchestration."""

from __future__ import annotations

from types import SimpleNamespace

from services.danbooru_import import _insert_posts_and_links_tx
from utils import resolve_source


def test_resolve_source_prefers_registered_source() -> None:
    assert resolve_source("https://pixiv.net/artworks/1", "https://gelbooru.com/x") \
        == "https://pixiv.net/artworks/1"


def test_resolve_source_falls_back_on_empty_string() -> None:
    assert resolve_source("", "https://gelbooru.com/x") == "https://gelbooru.com/x"


def test_resolve_source_falls_back_on_none() -> None:
    assert resolve_source(None, "https://gelbooru.com/x") == "https://gelbooru.com/x"


def test_danbooru_insert_uses_registered_source_then_falls_back(db) -> None:
    cur = db.cursor()
    with_src = SimpleNamespace(id=111, file_ext="jpg", source="https://pixiv.net/i/111",
                               rating="general", created_at="2026-01-01 00:00:00+00:00")
    without_src = SimpleNamespace(id=222, file_ext="png", source="",
                                  rating="general", created_at="2026-01-01 00:00:00+00:00")
    _insert_posts_and_links_tx(cur, "danbooru/test", [with_src, without_src], [{}, {}])

    cur.execute("SELECT source FROM posts WHERE file_name = '111'")
    assert cur.fetchone()[0] == "https://pixiv.net/i/111"
    cur.execute("SELECT source FROM posts WHERE file_name = '222'")
    assert cur.fetchone()[0] == "https://danbooru.donmai.us/posts/222"
