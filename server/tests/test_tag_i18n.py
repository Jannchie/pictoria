"""Tests for tag display-name localisation (services.tag_i18n).

Runs against the real ``data/tag.*.json`` tables (built by
``scripts/tags/build_tag_i18n.py``) — entries for staple danbooru tags are
stable across regenerations.
"""

from __future__ import annotations

from services.tag_i18n import search_tags_by_translation, translate_tag


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


def test_known_artist_without_official_name_has_no_entry() -> None:
    # The danbooru_metadata name maps know these artists but give them no
    # zh/ja name — authoritative absence. The GPT-era literal guesses
    # ("cutesexyrobutts" -> "可爱性感的机器人屁股") must not survive the build;
    # the UI falls back to the raw tag name.
    assert translate_tag("cutesexyrobutts") is None
    assert translate_tag("ask_(askzy)") is None
    assert translate_tag("cutesexyrobutts", lang="ja") is None


def test_character_without_wiki_name_keeps_gpt_fallback() -> None:
    # Characters are NOT in the authority set: established localized names
    # exist and GPT mostly got them right, so a missing wiki other_name keeps
    # the legacy entry instead of dropping to the raw tag name.
    assert translate_tag("lum") == "拉姆"
    assert translate_tag("kurosawa_ruby") == "黑泽露比"


def test_search_by_translation_exact_display_name() -> None:
    assert "green_eyes" in search_tags_by_translation("绿眼")


def test_search_by_translation_substring() -> None:
    # Substring of the display name is enough — search-as-you-type.
    assert "green_eyes" in search_tags_by_translation("绿")


def test_search_by_translation_blank_query_returns_nothing() -> None:
    assert search_tags_by_translation("") == []
    assert search_tags_by_translation("   ") == []


def test_search_by_translation_en_short_circuits() -> None:
    # English has no table; the raw tag name is already what the user types.
    assert search_tags_by_translation("eyes", lang="en") == []
