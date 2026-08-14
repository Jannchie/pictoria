"""WDTagger result persistence and the lazy model loader.

Persists tagger output (tags + group assignment + post links) for single
posts and batches; both paths share the canonical-tag-group resolution and
the same upsert SQL. The model itself is loaded once, on first use, behind
a thread lock (workers call ``get_tagger`` from ``asyncio.to_thread``).
"""

from __future__ import annotations

import threading
from functools import cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:

    import wdtagger

TAG_GROUP_COLORS: dict[str, str] = {
    "general": "#006192",
    "character": "#8243ca",
    "artist": "#f30000",
    "copyright": "#00b300",
}


# ─── wdtagger model loader (lazy) ──────────────────────────────────────
@cache
def _get_tagger() -> wdtagger.Tagger:
    import wdtagger  # noqa: PLC0415  # lazy: defer ML stack load until first use

    return wdtagger.Tagger(model_repo="SmilingWolf/wd-vit-large-tagger-v3")


_tagger_lock = threading.Lock()


def get_tagger():
    with _tagger_lock:
        return _get_tagger()
