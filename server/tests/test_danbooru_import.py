"""Unit tests for the pure pieces of the Danbooru importer (``worker.importers``).

The orchestration needs a live ``DanbooruClient``, but the tag-mapping and the
filename sanitiser are pure — they used to be buried in the controller and now
have a home that can be exercised directly.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

import pytest

from utils import rating_to_int
from worker import handlers, importers
from worker.importers import _build_tag_to_group, _row_for, _settled_page_stopper, handle_danbooru_download

if TYPE_CHECKING:
    from pathlib import Path


def _post(post_id: int, *, ext: str = "jpg", url: str | None = "https://cdn/x") -> SimpleNamespace:
    """The three fields ``_is_importable`` and the stopper actually read."""
    return SimpleNamespace(id=post_id, file_ext=ext, file_url=url)


def test_build_tag_to_group_keeps_highest_priority_group() -> None:
    post = SimpleNamespace(
        tag_string_artist="alice",
        tag_string_character="bob alice",  # 'alice' recurs at lower priority
        tag_string_general="solo",
    )
    # dict order = priority order
    type_to_group = {"artist": 1, "character": 2, "general": 3}

    result = _build_tag_to_group(post, type_to_group)

    assert result == {"alice": 1, "bob": 2, "solo": 3}


def test_build_tag_to_group_handles_empty_fields() -> None:
    post = SimpleNamespace(tag_string_artist="", tag_string_general="  a   b ")
    assert _build_tag_to_group(post, {"artist": 1, "general": 2}) == {"a": 2, "b": 2}


def test_settled_pages_stop_paging_after_the_streak() -> None:
    stop = _settled_page_stopper({"1", "2"}, streak=2)

    assert stop([_post(1), _post(2)]) is False  # settled, but streak of 1
    assert stop([_post(1), _post(2)]) is True


def test_a_pending_post_resets_the_streak() -> None:
    # Post 9 is importable and untagged — a gap from a failed download, or a
    # bare row still awaiting its tags. Paging must walk past it, not stop.
    stop = _settled_page_stopper({"1"}, streak=2)

    assert stop([_post(1)]) is False
    assert stop([_post(1), _post(9)]) is False
    assert stop([_post(1)]) is False  # streak restarted from zero
    assert stop([_post(1)]) is True


def test_unimportable_posts_neither_block_nor_advance_the_streak() -> None:
    # Videos and deleted posts can never be imported, so they must not keep a
    # settled page looking pending — but a page made only of them proves
    # nothing about having caught up either.
    stop = _settled_page_stopper({"1"}, streak=2)

    assert stop([_post(7, ext="mp4"), _post(8, url=None)]) is False  # no evidence
    assert stop([_post(1), _post(7, ext="mp4")]) is False  # settled: streak 1
    assert stop([_post(1)]) is True


def test_an_empty_import_history_never_settles_a_page() -> None:
    # A first-ever import has nothing to recognise, so it must walk to the tail
    # even at streak=1.
    stop = _settled_page_stopper(set(), streak=1)

    assert stop([_post(1), _post(2)]) is False


def test_rating_accepts_every_upstream_spelling() -> None:
    # One-letter booru form (Danbooru API, gallery-dl booru metadata, the
    # danbooru2026 archive) and gallery-dl's spelled-out words.
    assert [rating_to_int(r) for r in ("g", "s", "q", "e")] == [1, 2, 3, 4]
    assert [rating_to_int(r) for r in ("general", "sensitive", "questionable", "explicit")] == [1, 2, 3, 4]
    assert rating_to_int("E") == 4
    assert [rating_to_int(r) for r in ("", None, "x", "unknown", 3)] == [0, 0, 0, 0, 0]


def test_danbooru_rows_carry_the_api_one_letter_rating() -> None:
    # The Danbooru API sends ``rating: "q"``; a word-only map sent every
    # imported post to 0 ("not rated").
    post = SimpleNamespace(id=7, file_ext="png", source="", rating="q", created_at=None)
    assert _row_for(post, "danbooru/x", {})["rating"] == 3


def _item(post_id: int, ext: str = "png") -> dict[str, Any]:
    return {
        "fileUrl": f"https://cdn/{post_id}.{ext}",
        "fileSize": 3,
        "row": {
            "filePath": "danbooru/x",
            "fileName": str(post_id),
            "extension": ext,
            "source": f"https://danbooru.donmai.us/posts/{post_id}",
            "rating": 1,
            "publishedAt": None,
            "tags": {"x": 1},
        },
    }


@pytest.fixture
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path.resolve()
    monkeypatch.setattr(handlers, "_ROOT", root)
    return root


async def test_download_returns_rows_only_for_files_that_landed(library: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # A row must never exist before its file: sync would see it as deleted from
    # disk and remove it. So an item the client failed to fetch gets no row,
    # even though the listing handed it over with one already built.
    seen: list[Any] = []

    class Client:
        def download_posts(self, posts: list[Any], save_dir: Path) -> dict[str, int]:
            seen.extend(posts)
            (save_dir / f"{posts[0].id}.{posts[0].file_ext}").write_bytes(b"abc")
            return {"downloaded": 1, "skipped": 0, "failed": len(posts) - 1}

    monkeypatch.setattr(importers, "_danbooru_client", Client())
    save_dir = library / "danbooru" / "x"

    result = await handle_danbooru_download({"items": [_item(11), _item(12, "jpg")], "saveDir": str(save_dir)})

    assert [r["fileName"] for r in result["rows"]] == ["11"]
    assert (result["downloaded"], result["skipped"], result["failed"]) == (1, 0, 1)
    # The download target is rebuilt from the row: id and extension name the file.
    assert [(t.id, t.file_ext, t.file_url, t.file_size) for t in seen] == [
        (11, "png", "https://cdn/11.png", 3),
        (12, "jpg", "https://cdn/12.jpg", 3),
    ]


@pytest.mark.usefixtures("library")
async def test_download_refuses_a_save_dir_outside_the_library(tmp_path_factory: pytest.TempPathFactory) -> None:
    outside = tmp_path_factory.mktemp("elsewhere")
    with pytest.raises(ValueError, match="escapes"):
        await handle_danbooru_download({"items": [_item(1)], "saveDir": str(outside)})
