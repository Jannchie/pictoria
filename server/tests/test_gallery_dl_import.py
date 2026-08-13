"""Unit tests for the gallery-dl import workflow's pure pieces + orchestration."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from services import gallery_dl_import as gdl
from utils import resolve_source


def test_resolve_source_prefers_registered_source() -> None:
    assert resolve_source("https://pixiv.net/artworks/1", "https://gelbooru.com/x") \
        == "https://pixiv.net/artworks/1"


def test_resolve_source_falls_back_on_empty_string() -> None:
    assert resolve_source("", "https://gelbooru.com/x") == "https://gelbooru.com/x"


def test_resolve_source_falls_back_on_none() -> None:
    assert resolve_source(None, "https://gelbooru.com/x") == "https://gelbooru.com/x"


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


def test_parse_entry_kemono_multi_attachment_unique_file_names() -> None:
    # Real kemono shape: every attachment of one post shares `id`; only `num`
    # (1-based) and hash/filename differ. Without disambiguation the upsert on
    # (file_path, file_name, extension) silently collapses a multi-image post
    # into one row (observed live: 139 fetched -> 33 rows).
    base = {"category": "kemono", "extension": "jpeg", "username": "AVADIO",
            "user": "177539829", "id": "138330444", "type": "attachment"}
    first = gdl.parse_entry("https://n2.kemono.cr/data/a3.jpg", {**base, "num": 1, "filename": "IMG_9828"},
                            fallback_url="https://kemono.cr/patreon/user/177539829")
    second = gdl.parse_entry("https://n2.kemono.cr/data/48.jpg", {**base, "num": 2, "filename": "IMG_9836"},
                             fallback_url="https://kemono.cr/patreon/user/177539829")
    assert first is not None
    assert second is not None
    assert first.file_name == "138330444_1"
    assert second.file_name == "138330444_2"
    assert first.file_name != second.file_name


def _item(**kw):
    base = {
        "download_url": "u", "file_name": "f", "extension": "jpg", "source": "s",
        "category": "gelbooru", "creator": "hews", "rating": 0, "published_at": None,
        "tags_by_category": {},
    }
    base.update(kw)
    return gdl.GalleryDLItem(**base)


def test_build_tag_to_group_maps_each_category() -> None:
    item = _item(tags_by_category={"artist": ["hews"], "general": ["1girl", "solo"],
                                   "meta": ["highres"]})
    type_to_group = {"artist": 1, "character": 2, "copyright": 3, "general": 4, "meta": 5}
    assert gdl.build_tag_to_group(item, type_to_group) == {
        "hews": 1, "1girl": 4, "solo": 4, "highres": 5,
    }


def test_build_tag_to_group_empty_for_kemono() -> None:
    type_to_group = {"artist": 1, "general": 4}
    assert gdl.build_tag_to_group(_item(tags_by_category={}), type_to_group) == {}


def test_download_items_writes_files(tmp_path, monkeypatch) -> None:
    class _FakeResp:
        content = b"\x89PNG\r\n"

        def raise_for_status(self) -> None:
            """No-op: the fake response is always OK."""

    monkeypatch.setattr(gdl.httpx, "get", lambda *a, **k: _FakeResp())
    items = [_item(download_url="https://f/1.jpg", file_name="1", extension="jpg"),
             _item(download_url="https://f/2.png", file_name="2", extension="png")]
    ok = gdl.download_items(items, tmp_path)
    assert (tmp_path / "1.jpg").read_bytes() == b"\x89PNG\r\n"
    assert (tmp_path / "2.png").exists()
    # as_completed yields in finish order, so compare as a set.
    assert sorted(it.file_name for it in ok) == ["1", "2"]


def test_download_items_excludes_failures(tmp_path, monkeypatch) -> None:
    def boom(*a, **k):
        raise RuntimeError("network")

    monkeypatch.setattr(gdl.httpx, "get", boom)
    ok = gdl.download_items(
        [_item(download_url="https://f/1.jpg", file_name="1", extension="jpg")], tmp_path)
    assert ok == []
