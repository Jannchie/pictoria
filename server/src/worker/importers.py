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

Danbooru runs as two tasks, like gallery-dl: ``danbooru-list`` walks the
listing and returns what is still to import, ``danbooru-download`` fetches one
chunk of it at a time so TS can persist (and report progress) per chunk.

Download-before-persist is preserved by construction: the download half returns
rows only for posts whose bytes are already on disk, and TS writes them
afterwards. A row must never exist before its file, or a concurrent
``sync-metadata`` sees it as "file deleted from disk" and removes it
mid-download.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from paths import pictoria_dir
from utils import SUPPORTED_IMAGE_EXTS
from worker.handlers import _resolve_inside, library_root

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

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


# ─── Danbooru ─────────────────────────────────────────────────────────────

#: How many consecutive listing pages must hold nothing left to import before
#: pagination gives up. Pages arrive newest-id-first, so one such page already
#: means we're in history; two is cheap insurance against a page that only
#: looks settled (e.g. a batch whose files failed to download last run and were
#: since deleted upstream).
_SETTLED_PAGE_STREAK = 2


def _is_importable(post: DanbooruPost) -> bool:
    """Would this listing entry ever produce a file we keep?

    The single definition of what this importer accepts — the ``filtered``
    narrowing and the pagination stopper both go through it. Entries that fail
    it (deleted/banned posts with no ``file_url``, videos, zips) can never be
    imported, so the stopper must not count them as "still pending", or a
    single upstream video would keep a settled page looking unfinished and
    defeat early termination forever.
    """
    return bool(post.file_url) and bool(post.file_ext) and post.file_ext.lower() in SUPPORTED_IMAGE_EXTS


def _is_pending(post: DanbooruPost, imported_ids: set[str]) -> bool:
    """Is this post one we still have to fetch?

    The whole dedup rule in one place. The stopper and the ``to_persist``
    filter must agree on it exactly: a stopper that counts a still-wanted post
    as settled stops paging over posts the importer would have taken.
    """
    return _is_importable(post) and str(post.id) not in imported_ids


def _settled_page_stopper(
    imported_ids: set[str],
    streak: int = _SETTLED_PAGE_STREAK,
) -> Callable[[list[DanbooruPost]], bool]:
    """Build the ``stop_paging`` predicate for ``DanbooruClient.get_posts``.

    A page is *settled* when it holds at least one post we've already imported
    with tags and none that still need importing. ``streak`` settled pages in a
    row ends pagination. Requiring a positive already-imported hit is what
    separates "we've caught up with history" from "this page happens to be all
    videos" — the latter neither advances nor resets the streak.

    Any pending post resets the streak, so gaps (a download that failed last
    run, a bare row awaiting its tags) still get walked past and retried.
    """
    settled_run = 0

    def _stop(page: list[DanbooruPost]) -> bool:
        nonlocal settled_run
        if any(_is_pending(p, imported_ids) for p in page):
            settled_run = 0
            return False
        if any(str(p.id) in imported_ids for p in page):
            settled_run += 1
        return settled_run >= streak

    return _stop


def _build_tag_to_group(d_post: DanbooruPost, type_to_group_id: dict[str, int]) -> dict[str, int]:
    """Collect (tag_name → group_id) from a Danbooru post's tag_string_* fields.

    `type_to_group_id` is ordered by priority; setdefault keeps the first
    (highest-priority) group when a tag appears under multiple types.
    """
    tag_to_group: dict[str, int] = {}
    for t, gid in type_to_group_id.items():
        # str.split() with no args also drops empty entries
        for tag_str in getattr(d_post, f"tag_string_{t}").split():
            tag_to_group.setdefault(tag_str, gid)
    return tag_to_group


def _row_for(post: DanbooruPost, file_path_str: str, tag_map: dict[str, int]) -> dict[str, Any]:
    """One Danbooru post as the ``posts`` table's own terms (+ its tag map)."""
    from utils import rating_to_int, resolve_source  # noqa: PLC0415

    return {
        "filePath": file_path_str,
        "fileName": str(post.id),
        "extension": post.file_ext,
        "source": resolve_source(post.source, f"https://danbooru.donmai.us/posts/{post.id}"),
        "rating": rating_to_int(post.rating),
        # ISO string rather than a datetime: it has to survive a JSON hop.
        "publishedAt": None if post.created_at is None else post.created_at.isoformat(),
        "tags": tag_map,
    }


async def handle_danbooru_list(payload: dict[str, Any]) -> dict[str, Any]:
    """Walk a Danbooru tag listing, return the posts still to import.

    The first half of a tag import; :func:`handle_danbooru_download` is the
    second. Split so TS can download in chunks and persist after each one — a
    tag with hundreds of new files is a quarter of an hour at the CDN's ~1 req/s,
    and as one task it showed no progress and persisted nothing on a mid-way
    failure.

    Each item's row is built here, not after the download: the tag map comes
    from the listing's ``tag_string_*`` fields, which the download half never
    sees. The pagination stopper is the subtle part — see
    :func:`_settled_page_stopper`.
    """
    client = _get_danbooru_client()
    tags = payload["tags"]
    file_path_str = payload["filePathStr"]
    imported_ids = set(payload["importedIds"])
    type_to_group_id = payload["typeToGroupId"]
    limit = int(payload["limit"])
    full_scan = bool(payload["fullScan"])

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
    to_import = [p for p in filtered if _is_pending(p, imported_ids)]

    return {
        "items": [
            {
                "fileUrl": str(p.file_url),
                "fileSize": p.file_size,
                "row": _row_for(p, file_path_str, _build_tag_to_group(p, type_to_group_id)),
            }
            for p in to_import
        ],
        "stats": {
            "total": len(posts_orig),
            "withUrl": sum(1 for p in posts_orig if p.file_url),
            "filtered": len(filtered),
            "earlyStopped": early_stopped,
        },
    }


@dataclass(frozen=True, slots=True)
class _DownloadTarget:
    """The four fields ``DanbooruClient.download_posts`` reads (``danbooru.Downloadable``).

    Rebuilt from a payload item: the listing's ``DanbooruPost`` did not survive
    the hop between the two tasks, and the downloader never needed the rest of
    it. ``id`` / ``file_ext`` come from the row because they *are* its
    ``fileName`` / ``extension`` — the file lands at ``<id>.<file_ext>``, which
    is exactly the path the row names.
    """

    id: int
    file_url: str
    file_ext: str
    file_size: int


async def handle_danbooru_download(payload: dict[str, Any]) -> dict[str, Any]:
    """Download one chunk of listed items, return rows for the ones on disk.

    A file that is already there counts as ``skipped`` and still comes back as
    a row: that is how a chunk whose bytes landed but whose rows never got
    persisted (the API died between the two) heals on the next run.
    """
    # Same containment rule as every other payload path: the importer writes
    # files, and a ``saveDir`` outside the library is not somewhere it may.
    save_dir = _resolve_inside(payload["saveDir"])
    raw_items = payload["items"]
    if not raw_items:
        return {"rows": [], "downloaded": 0, "skipped": 0, "failed": 0}

    # off-loop: a mkdir on a cold network path is not free, and this handler's
    # event loop is also renewing the task lease.
    await asyncio.to_thread(save_dir.mkdir, parents=True, exist_ok=True)

    pairs = [
        (
            _DownloadTarget(
                id=int(it["row"]["fileName"]),
                file_url=it["fileUrl"],
                file_ext=it["row"]["extension"],
                file_size=int(it["fileSize"]),
            ),
            it["row"],
        )
        for it in raw_items
    ]
    client = _get_danbooru_client()
    dl_stats = await asyncio.to_thread(client.download_posts, [t for t, _ in pairs], save_dir)

    # Only items whose bytes actually landed. A download can 4xx, and a row
    # without its file is exactly what the sync reconciler deletes.
    def _on_disk(target: _DownloadTarget) -> bool:
        return (save_dir / f"{target.id}.{target.file_ext}").exists()

    landed = await asyncio.to_thread(lambda: [row for t, row in pairs if _on_disk(t)])

    return {
        "rows": landed,
        "downloaded": dl_stats.get("downloaded", 0),
        "skipped": dl_stats.get("skipped", 0),
        "failed": dl_stats.get("failed", 0),
    }


# ─── gallery-dl（多站点导入） ──────────────────────────────────────────


def _gallery_dl_conf(root: Path) -> str | None:
    """Optional gallery-dl.conf (kemono cookies / UA) at ``<root>/.pictoria/``."""
    conf = pictoria_dir(root) / "gallery-dl.conf"
    return str(conf) if conf.is_file() else None


async def handle_url_scan(payload: dict[str, Any]) -> dict[str, Any]:
    """``gallery-dl -j <url>`` → the parsed, image-only item list.

    Split from the download half on purpose: the dedup check ("which of these
    file names does the library already have under this directory?") is a
    database read, and this process has none. So it returns the candidates, TS
    filters them, and the survivors come back to :func:`handle_url_download`.

    ``filePath`` comes from the first item — every item behind one URL shares
    category/creator, which is exactly what makes it one directory.
    """
    from services.gallery_dl_import import parse_entry, run_gallery_dl_json  # noqa: PLC0415

    url = payload["url"]
    raw = await asyncio.to_thread(run_gallery_dl_json, url, config_path=_gallery_dl_conf(library_root()))

    items = []
    for dl_url, meta in raw:
        it = parse_entry(dl_url, meta, fallback_url=url)
        if it is None:
            continue
        items.append(
            {
                "downloadUrl": it.download_url,
                "fileName": it.file_name,
                "extension": it.extension,
                "source": it.source,
                "category": it.category,
                "creator": it.creator,
                "rating": it.rating,
                "publishedAt": it.published_at,
                "tagsByCategory": it.tags_by_category,
            },
        )

    file_path = f"{items[0]['category']}/{items[0]['creator']}" if items else ""
    return {"fetched": len(raw), "filePath": file_path, "items": items}


async def handle_url_download(payload: dict[str, Any]) -> dict[str, Any]:
    """Download the items TS decided are new, return rows for the ones that landed.

    Same download-before-persist ordering as the Danbooru importer: only bytes
    already on disk come back as rows, so a concurrent ``sync-metadata`` can
    never see a post row without its file.
    """
    from services.gallery_dl_import import GalleryDLItem, build_tag_to_group, download_items  # noqa: PLC0415

    raw_items = payload["items"]
    if not raw_items:
        return {"rows": [], "downloaded": 0, "failed": 0}

    save_dir = _resolve_inside(payload["saveDir"])
    file_path_str = payload["filePathStr"]
    type_to_group_id = payload["typeToGroupId"]

    items = [
        GalleryDLItem(
            download_url=r["downloadUrl"],
            file_name=r["fileName"],
            extension=r["extension"],
            source=r["source"],
            category=r["category"],
            creator=r["creator"],
            rating=r["rating"],
            published_at=r["publishedAt"],
            tags_by_category=r["tagsByCategory"],
        )
        for r in raw_items
    ]

    ok = await asyncio.to_thread(download_items, items, save_dir)
    return {
        "rows": [
            {
                "filePath": file_path_str,
                "fileName": it.file_name,
                "extension": it.extension,
                "source": it.source,
                "rating": it.rating,
                "publishedAt": it.published_at,
                "tags": build_tag_to_group(it, type_to_group_id),
            }
            for it in ok
        ],
        "downloaded": len(ok),
        "failed": len(items) - len(ok),
    }
