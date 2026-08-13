"""Unit tests for the pure pieces of the Danbooru import workflow.

The orchestration needs a live ``DanbooruClient``, but the tag-mapping and the
filename sanitiser are pure — they used to be buried in the controller and now
have a home that can be exercised directly.
"""

from __future__ import annotations

from types import SimpleNamespace

from services.danbooru_import import _build_tag_to_group, _settled_page_stopper


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
