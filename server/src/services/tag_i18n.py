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
