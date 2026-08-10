"""Importers that run in the worker: Danbooru and gallery-dl.

Both are "fetch the outside world, put bytes on disk, hand back rows" — which
is compute plus external IO, so under §D1 they live here and the ``posts`` /
``tags`` writes happen in TS.

Two things the payload has to carry, because this process has no database:

* ``importedIds`` — the Danbooru post ids already imported *with tags*. The
  dedup filter **and** the pagination stopper both consult it, so it can't be
  recomputed here.
* ``typeToGroupId`` — the canonical tag-group ids. Tag→group is schema
  knowledge; the worker only flattens Danbooru's ``tag_string_*`` fields
  through the map it's given.

Download-before-persist is preserved by construction: this returns rows only
for posts whose bytes are already on disk, and TS writes them afterwards. A row
must never exist before its file, or a concurrent ``sync-metadata`` sees it as
"file deleted from disk" and removes it mid-download.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from danbooru import DanbooruPost

#: Cached across calls so httpx keeps the TCP/TLS connection to
#: danbooru.donmai.us alive across tag downloads — and, more importantly, so the
#: client's two rate-limit gates (API and CDN) stay warm. A fresh client per
#: request would reset them and walk straight into a 429.
_danbooru_client: Any = None


def _get_danbooru_client() -> Any:
    global _danbooru_client  # noqa: PLW0603 — process-wide singleton, same as the old app.state one
    if _danbooru_client is None:
        from danbooru import DanbooruClient  # noqa: PLC0415  # lazy: pulls httpx

        _danbooru_client = DanbooruClient(
            os.environ.get("DANBOORU_API_KEY", ""),
            os.environ.get("DANBOORU_USER_NAME", ""),
        )
    return _danbooru_client


def _row_for(post: DanbooruPost, file_path_str: str, tag_map: dict[str, int]) -> dict[str, Any]:
    """One Danbooru post as the ``posts`` table's own terms (+ its tag map)."""
    from utils import from_rating_to_int, resolve_source  # noqa: PLC0415

    return {
        "filePath": file_path_str,
        "fileName": str(post.id),
        "extension": post.file_ext,
        "source": resolve_source(post.source, f"https://danbooru.donmai.us/posts/{post.id}"),
        "rating": from_rating_to_int(post.rating),
        # ISO string rather than a datetime: it has to survive a JSON hop.
        "publishedAt": None if post.created_at is None else post.created_at.isoformat(),
        "tags": tag_map,
    }


async def handle_danbooru_import(payload: dict[str, Any]) -> dict[str, Any]:
    """Fetch a Danbooru tag listing, download the new files, return rows.

    Everything up to (but not including) the database write, lifted out of
    ``services/danbooru_import.py``. That module's helpers are reused rather
    than re-derived — the pagination stopper in particular is subtle and tuned
    (see its docstring), and a second implementation would drift.
    """
    from services.danbooru_import import (  # noqa: PLC0415
        _build_tag_to_group,
        _is_importable,
        _is_pending,
        _settled_page_stopper,
    )

    client = _get_danbooru_client()
    tags = payload["tags"]
    save_dir = Path(payload["saveDir"])
    file_path_str = payload["filePathStr"]
    imported_ids = set(payload["importedIds"])
    type_to_group_id = payload["typeToGroupId"]
    limit = int(payload["limit"])
    full_scan = bool(payload["fullScan"])

    # off-loop: a mkdir on a cold network path is not free, and this handler's
    # event loop is also renewing the task lease.
    await asyncio.to_thread(save_dir.mkdir, parents=True, exist_ok=True)

    stopper = None if full_scan else _settled_page_stopper(imported_ids)
    early_stopped = False

    def _stop_paging(page: list[DanbooruPost]) -> bool:
        # The last verdict is the answer: paging only ends on a True.
        nonlocal early_stopped
        early_stopped = stopper is not None and stopper(page)
        return early_stopped

    def _fetch() -> list[DanbooruPost]:
        return client.get_posts(
            tags=tags,
            limit=limit,
            stop_paging=None if stopper is None else _stop_paging,
        )

    posts_orig = await asyncio.to_thread(_fetch)
    filtered = [p for p in posts_orig if _is_importable(p)]
    to_persist = [p for p in filtered if _is_pending(p, imported_ids)]

    if to_persist:
        dl_stats = await asyncio.to_thread(client.download_posts, to_persist, save_dir)
    else:
        dl_stats = {"downloaded": 0, "skipped": 0, "failed": 0}

    # Only posts whose bytes actually landed. A download can 4xx, and a row
    # without its file is exactly what the sync reconciler deletes.
    def _on_disk(post: DanbooruPost) -> bool:
        return (save_dir / f"{post.id}.{post.file_ext}").exists()

    landed = await asyncio.to_thread(lambda: [p for p in to_persist if _on_disk(p)])

    return {
        "rows": [_row_for(p, file_path_str, _build_tag_to_group(p, type_to_group_id)) for p in landed],
        "stats": {
            "total": len(posts_orig),
            "with_url": sum(1 for p in posts_orig if p.file_url),
            "filtered": len(filtered),
            "downloaded": dl_stats.get("downloaded", 0),
            "skipped": (len(filtered) - len(to_persist)) + dl_stats.get("skipped", 0),
            "failed": dl_stats.get("failed", 0),
            "early_stopped": early_stopped,
        },
    }
