"""Tests for tag display-name localisation (services.tag_i18n).

Runs against the real ``data/tag.*.json`` tables (built by
``scripts/tags/build_tag_i18n.py``) — entries for staple danbooru tags are
stable across regenerations.
"""

from __future__ import annotations

from services.tag_i18n import translate_tag


def test_curated_tree_entry() -> None:
    # Staple tag covered by the danbooru-tags-tree source.
    assert translate_tag("green_eyes") == "绿眼"


def test_legacy_fallback_entry() -> None:
    # Character tags aren't in the curated tree; the GPT-era fallback covers them.
    assert translate_tag("mulan") == "花木兰"


def test_japanese_table() -> None:
    assert translate_tag("green_eyes", lang="ja") == "緑目"


def test_unknown_tag_returns_none() -> None:
    assert translate_tag("definitely_not_a_real_tag_zzz") is None


def test_missing_language_table_returns_none() -> None:
    # No data/tag.en.json exists on disk - must degrade to None, not raise.
    assert translate_tag("green_eyes", lang="en") is None
