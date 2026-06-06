"""Tag display-name localisation.

``data/tag.<lang>.json`` maps DB tag names (danbooru underscore form,
"green_eyes") to localised display names. Tables are built offline by
``scripts/tags/build_tag_i18n.py`` from the curated danbooru-tags-tree
multilingual YAML, with the legacy GPT-translated entries kept as fallback
for character/artist tags the tree doesn't cover. English needs no table
(the tag itself is the English display name), so a missing table or a
missing entry yields ``None`` and callers fall back to the raw name.
Tables are loaded once per process on first use (~2 MB JSON for zh-Hans).
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

from shared import logger

_DATA_DIR = Path(__file__).resolve().parents[2] / "data"


@cache
def _table(lang: str) -> dict[str, str]:
    path = _DATA_DIR / f"tag.{lang}.json"
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        logger.warning(f"No tag translation table for {lang!r} at {path}")
        return {}


def translate_tag(name: str, lang: str = "zh-Hans") -> str | None:
    """Localised display name for a DB tag name, or ``None`` when unknown.

    ``en`` short-circuits: the raw tag name *is* the English display name, so
    there is no table to consult (and no missing-table warning to emit).
    """
    if lang == "en":
        return None
    return _table(lang).get(name)


@cache
def _search_index(lang: str) -> list[tuple[str, str]]:
    """(casefolded display name, DB tag name) pairs for substring search."""
    return [(display.casefold(), name) for name, display in _table(lang).items()]


# Bounds the IN(...) parameter list callers build from a search result. Only
# single-character CJK queries get anywhere near this; SQLite's variable limit
# is 32766, so 5000 leaves ample headroom for the caller's other parameters.
MAX_TRANSLATION_MATCHES = 5000


def search_tags_by_translation(query: str, lang: str = "zh-Hans") -> list[str]:
    """DB tag names whose localised display name contains ``query``.

    Case-insensitive substring match, linearly scanned — a few ms over the
    ~100k-entry table, fine behind the frontend's 250ms search debounce.
    Returns [] for an empty query or for ``en`` (no table; the raw tag name is
    already what the user is typing against).
    """
    q = query.strip().casefold()
    if not q or lang == "en":
        return []
    matches: list[str] = []
    for display, name in _search_index(lang):
        if q in display:
            matches.append(name)
            if len(matches) >= MAX_TRANSLATION_MATCHES:
                break
    return matches
