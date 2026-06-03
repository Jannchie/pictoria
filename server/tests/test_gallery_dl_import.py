"""Unit tests for the gallery-dl import workflow's pure pieces + orchestration."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from services import gallery_dl_import as gdl
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


def test_run_gallery_dl_json_extracts_url_message(monkeypatch) -> None:
    # type==3 => Url message: [3, "<download url>", {kwdict}]; type 2 (Directory) ignored.
    fake_stdout = json.dumps([
        [2, {"category": "gelbooru"}],
        [3, "https://img/1.jpg", {"id": 1, "extension": "jpg"}],
        [3, "https://img/2.png", {"id": 2, "extension": "png"}],
    ])
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, stdout=fake_stdout, stderr=""))
    out = gdl.run_gallery_dl_json("https://gelbooru.com/x")
    assert out == [
        ("https://img/1.jpg", {"id": 1, "extension": "jpg"}),
        ("https://img/2.png", {"id": 2, "extension": "png"}),
    ]


def test_run_gallery_dl_json_returns_empty_on_nonzero_exit(monkeypatch) -> None:
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 1, stdout="", stderr="403 Forbidden"))
    assert gdl.run_gallery_dl_json("https://kemono.cr/x") == []


def test_run_gallery_dl_json_returns_empty_on_garbage(monkeypatch) -> None:
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, stdout="not json", stderr=""))
    assert gdl.run_gallery_dl_json("https://gelbooru.com/x") == []


def test_run_gallery_dl_json_parses_real_yandere_fixture(monkeypatch) -> None:
    fixture = (Path(__file__).parent / "fixtures" / "gallerydl_yandere.json").read_text(encoding="utf-8-sig")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, stdout=fixture, stderr=""))
    out = gdl.run_gallery_dl_json("https://yande.re/post?tags=landscape")
    assert len(out) == 2  # two type-3 url messages (range 1-2)
    url, meta = out[0]
    assert url.startswith("https://files.yande.re/")
    assert meta["category"] == "yandere"
    assert meta["extension"] == "png"


def test_parse_entry_moebooru_flat_tags_to_general() -> None:
    # Real yande.re shape: flat `tags`, single-letter rating, numeric id.
    meta = {"category": "yandere", "id": 1263248, "filename": "yande.re 1263248 landscape",
            "extension": "png", "rating": "s", "source": "https://www.xiaohongshu.com/x",
            "date": "2026-06-03 08:54:48", "search_tags": "landscape",
            "tags": "dress landscape wuthering_waves"}
    item = gdl.parse_entry("https://files.yande.re/image/x.png", meta,
                           fallback_url="https://yande.re/post/show/1263248")
    assert item is not None
    assert item.file_name == "1263248"          # id, not the long filename
    assert item.extension == "png"
    assert item.rating == 2                      # booru "s" -> sensitive
    assert item.source == "https://www.xiaohongshu.com/x"
    assert item.published_at == "2026-06-03 08:54:48"
    assert item.creator == "landscape"
    assert item.tags_by_category == {"general": ["dress", "landscape", "wuthering_waves"]}


def test_parse_entry_categorised_booru_tags() -> None:
    # gelbooru/danbooru shape: per-category tag fields, single-letter rating "g".
    meta = {"category": "gelbooru", "id": 5, "extension": "jpg", "rating": "g", "source": "",
            "tags_artist": "hews", "tags_character": "rin", "tags_copyright": "vocaloid",
            "tags_general": "1girl solo", "tags_metadata": "highres", "search_tags": "hews"}
    item = gdl.parse_entry("https://f/5.jpg", meta, fallback_url="https://gelbooru.com/post/5")
    assert item is not None
    assert item.rating == 1                      # "g" -> general
    assert item.source == "https://gelbooru.com/post/5"   # empty source -> fallback
    assert item.tags_by_category["artist"] == ["hews"]
    assert item.tags_by_category["general"] == ["1girl", "solo"]
    assert item.tags_by_category["meta"] == ["highres"]
    assert "tags" not in item.tags_by_category   # categorised path, not flat fallback


def test_parse_entry_skips_non_image() -> None:
    meta = {"category": "kemono", "id": "p001", "filename": "efgh", "extension": "zip"}
    assert gdl.parse_entry("https://f/efgh.zip", meta, fallback_url="x") is None


def test_parse_entry_kemono_no_tags_fallback_source() -> None:
    meta = {"category": "kemono", "id": "p001", "filename": "abcd", "extension": "png",
            "username": "alice", "date": "2026-05-01 10:00:00"}
    item = gdl.parse_entry("https://n1.kemono.cr/data/abcd.png", meta,
                           fallback_url="https://kemono.cr/patreon/user/12345")
    assert item is not None
    assert item.tags_by_category == {}
    assert item.source == "https://kemono.cr/patreon/user/12345"
    assert item.creator == "alice"               # username
    assert item.file_name == "p001"
