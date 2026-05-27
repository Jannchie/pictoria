"""Unit tests for the pure pieces of the Danbooru import workflow.

The orchestration needs a live ``DanbooruClient``, but the tag-mapping and the
filename sanitiser are pure — they used to be buried in the controller and now
have a home that can be exercised directly.
"""

from __future__ import annotations

from types import SimpleNamespace

from services.danbooru_import import _build_tag_to_group, _safe_dir_name


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


def test_safe_dir_name_sanitises_filesystem_illegal_chars() -> None:
    assert _safe_dir_name("re:rin") == "re_rin"
    assert _safe_dir_name("a/b\\c") == "a_b_c"


def test_safe_dir_name_never_returns_empty() -> None:
    assert _safe_dir_name("...") == "_"
    assert _safe_dir_name("") == "_"
