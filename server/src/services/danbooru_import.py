"""Download a Danbooru tag search and persist the new posts + their tags.

Lifted out of ``CommandController.download_from_danbooru`` so the HTTP handler
is a thin call: fetch → filter to supported images → skip posts that already
have manual tags → download the files → persist the ones that landed on disk
(tags, then posts+links, each in its own retried transaction). Download precedes
persist on purpose: a post row must not exist before its file, or the sync
reconciler's ``remove_deleted_files`` races the throttled download and deletes
the just-committed post mid-flight (see ``import_danbooru_posts``). The
transaction/retry shape is load-bearing under concurrent imports.
"""

from __future__ import annotations

import asyncio
import functools
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import shared
from services.import_persist import (
    NormalizedPostRow,
    _insert_posts_tx,
    persist_posts_with_tags,
)
from shared import logger
from utils import from_rating_to_int, resolve_source

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Callable
    from concurrent.futures import Executor

    from danbooru import DanbooruClient, DanbooruPost
    from db import DB

# A whole-tag listing used to fetch ``limit=99999`` — up to ~500 serial /posts
# pages. Most artist tags short-circuit on the first short page, but big
# copyright/character tags would page for minutes inside a single to_thread
# call (which, with the client's read timeout disabled, the caller sees as a
# hang). Cap the default; common tags are unaffected, pathological ones are
# bounded.
_DEFAULT_LISTING_LIMIT = 5000

# How many consecutive listing pages must hold nothing left to import before
# pagination gives up. Pages arrive newest-id-first, so one such page already
# means we're in history; two is cheap insurance against a page that only
# looks settled (e.g. a batch whose files failed to download last run and were
# since deleted upstream).
_SETTLED_PAGE_STREAK = 2


async def _in_executor(executor: Executor | None, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Run blocking ``fn`` on ``executor`` (``None`` = asyncio's default pool).

    Danbooru imports are routed onto a dedicated pool (see ``app.state``) so a
    busy backfill — which keeps the default pool's worker threads occupied —
    can't starve the listing/download calls and stall the request mid-flight.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, functools.partial(fn, *args, **kwargs))


SUPPORTED_IMAGE_EXTS: frozenset[str] = frozenset(
    {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "tif", "svg"},
)

# Windows forbids these in filename components; Danbooru tags like `re:rin`
# would otherwise fail mkdir on win32.
_FS_ILLEGAL_CHARS: frozenset[str] = frozenset('<>:"/\\|?*')


def _safe_dir_name(name: str) -> str:
    sanitized = "".join("_" if c in _FS_ILLEGAL_CHARS or c < " " else c for c in name)
    return sanitized.rstrip(". ") or "_"


def _imported_danbooru_ids(db: DB, file_path_str: str) -> set[str]:
    """Danbooru post ids already imported *with tags* under ``file_path_str``.

    The ids come out of ``posts.file_name`` because that column *is* the
    Danbooru post id for this importer — see ``_danbooru_row``, which writes
    ``file_name=str(d_post.id)``. Both the dedup filter and the pagination
    stopper compare raw post ids against this set, so that equivalence is
    load-bearing in two places now.

    Deliberately raw SQL here rather than a ``PostQueryService`` read: this has
    to run on the Danbooru executor's worker thread (see below), while the query
    service's methods are ``async`` over ``asyncio.to_thread`` and would land on
    the default pool, losing exactly the thread affinity this depends on.

    Worker-thread-local cursor: ``db.cursor()`` returns a cursor on *this*
    thread's connection. The event-loop-thread connection is shared by every
    concurrent request, so doing BEGIN/COMMIT on it makes concurrent imports
    trample each other's transactions.

    Dedup on "already has a manual (is_auto=0) tag", NOT merely "the post row
    exists": a file can land in the DB tag-less first — folder-sync
    reconciliation (``PostRepo.create_paths``) inserts a bare row for any file
    already on disk, and a DB reset / snapshot rollback can leave files behind
    without their ``post_has_tag`` links. Keying on post-existence would skip
    those bare rows forever (their file_name is "present"), so the Danbooru
    tags never get written. Keying on manual-tag presence lets a re-run
    backfill them.
    """
    cur = db.cursor()
    try:
        cur.execute(
            """
            SELECT p.file_name
            FROM posts p
            JOIN post_has_tag pht
              ON pht.post_id = p.id AND pht.is_auto = 0
            WHERE p.file_path = ?
            """,
            [file_path_str],
        )
        return {row[0] for row in cur.fetchall()}
    finally:
        cur.close()


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


@dataclass
class DanbooruDownloadStats:
    """Outcome of one tag import.

    ``total``/``with_url``/``filtered`` count what we *scanned*, which is not
    the tag's size once ``early_stopped`` is true — a second run over an
    unchanged tag reports a few hundred where the first reported thousands.
    ``early_stopped`` is what tells those two cases apart.
    """

    total: int
    with_url: int
    filtered: int
    downloaded: int
    skipped: int
    failed: int
    early_stopped: bool


async def import_danbooru_posts(  # noqa: PLR0913
    *,
    client: DanbooruClient,
    type_to_group_id: dict[str, int],
    db: DB,
    tags: str,
    limit: int = _DEFAULT_LISTING_LIMIT,
    executor: Executor | None = None,
    full_scan: bool = False,
) -> DanbooruDownloadStats:
    """Download posts for ``tags`` from Danbooru and persist the new ones.

    The shared ``client`` and ``type_to_group_id`` come from startup state (see
    the module docstring); the DB-membership pre-check that short-circuits the
    download threadpool is the ``to_persist`` filter below. ``executor`` is the
    dedicated Danbooru thread pool — passing ``None`` falls back to asyncio's
    default pool (kept so the test suite can call this without app state).

    The same DB pre-check is fed to the listing as ``stop_paging`` so a re-run
    over an unchanged tag stops after one page instead of walking every page up
    to ``limit``. ``full_scan=True`` disables that: pagination runs to the tail,
    which is how a post that Danbooru tagged with this artist *after* we last
    imported its id-neighbours gets picked up. Early stop is the default because
    that case is rare and a periodic ``full_scan`` re-run covers it.
    """
    danbooru_dir = shared.target_dir / "danbooru"
    save_dir = danbooru_dir / _safe_dir_name(tags)
    await _in_executor(executor, save_dir.mkdir, parents=True, exist_ok=True)
    file_path_str = save_dir.relative_to(shared.target_dir).as_posix()

    imported_ids = await _in_executor(executor, _imported_danbooru_ids, db, file_path_str)
    stopper = None if full_scan else _settled_page_stopper(imported_ids)
    early_stopped = False

    def _stop_paging(page: list[DanbooruPost]) -> bool:
        # The last verdict is the answer: paging only ends on a True.
        nonlocal early_stopped
        early_stopped = stopper is not None and stopper(page)
        return early_stopped

    posts_orig = await _in_executor(
        executor,
        client.get_posts,
        tags=tags,
        limit=limit,
        stop_paging=None if stopper is None else _stop_paging,
    )
    filtered = [p for p in posts_orig if _is_importable(p)]
    logger.info(f"Fetched {len(filtered)} importable posts ({len(posts_orig)} scanned)")

    to_persist = [p for p in filtered if _is_pending(p, imported_ids)]
    # `filtered \ to_persist` was already imported *with tags*; its files are on
    # disk. `to_persist` may include tag-backfill posts whose file is already
    # present — ``download_image`` short-circuits those on its exists() check.
    logger.info(
        f"Downloading {len(to_persist)} posts ({len(filtered) - len(to_persist)} already imported with tags)",
    )

    # DOWNLOAD BEFORE PERSIST. A post row must never exist before its file does:
    # the importer commits on a worker connection, but the file lands seconds-to-
    # minutes later (the CDN download is throttled to ~1 req/s pool-wide). In
    # that gap a concurrent ``sync_metadata`` would run ``remove_deleted_files``,
    # see the freshly-committed rows as "file deleted from disk", and DELETE them
    # (FK-cascading their tags). The download then finishes, orphaning the files,
    # which the next sync re-adds as bare, tag-less rows — the exact source of
    # the source='' / no-manual-tag posts. Persisting only AFTER the bytes are on
    # disk closes that window: the reconciler never sees a row without its file.
    if to_persist:
        dl_stats = await _in_executor(executor, client.download_posts, to_persist, save_dir)
    else:
        dl_stats = {"downloaded": 0, "skipped": 0, "failed": 0}

    # Persist only the posts whose file actually made it to disk (a download can
    # fail/4xx). For those, the row is created with its file already present, so
    # the reconciler can't delete it; if sync happened to add a bare row in the
    # tiny post-download window, the persist's ON CONFLICT DO UPDATE upgrades it.
    def _on_disk(post: DanbooruPost) -> bool:
        return (save_dir / f"{post.id}.{post.file_ext}").exists()

    downloaded_posts = await _in_executor(executor, lambda: [p for p in to_persist if _on_disk(p)])
    precomputed_tag_maps = [_build_tag_to_group(p, type_to_group_id) for p in downloaded_posts]
    await _in_executor(
        executor,
        _persist_danbooru_batch,
        db,
        file_path_str,
        downloaded_posts,
        precomputed_tag_maps,
    )

    return DanbooruDownloadStats(
        total=len(posts_orig),
        with_url=sum(1 for p in posts_orig if p.file_url),
        filtered=len(filtered),
        downloaded=dl_stats.get("downloaded", 0),
        skipped=(len(filtered) - len(to_persist)) + dl_stats.get("skipped", 0),
        failed=dl_stats.get("failed", 0),
        early_stopped=early_stopped,
    )


def _danbooru_row(
    file_path_str: str,
    d_post: DanbooruPost,
    tag_map: dict[str, int],
) -> NormalizedPostRow:
    """Map one ``DanbooruPost`` (+ its precomputed tag→group map) to a post row.

    The file name is the Danbooru post id; the source falls back to the post's
    permalink when the upstream ``source`` is blank; the rating word is coerced
    to our int, and ``created_at`` is the published timestamp.
    """
    return NormalizedPostRow(
        file_path=file_path_str,
        file_name=str(d_post.id),
        extension=d_post.file_ext,
        source=resolve_source(d_post.source, f"https://danbooru.donmai.us/posts/{d_post.id}"),
        rating=from_rating_to_int(d_post.rating),
        published_at=d_post.created_at,
        tags=tag_map,
    )


def _persist_danbooru_batch(
    db: DB,
    file_path_str: str,
    to_persist: list[DanbooruPost],
    precomputed_tag_maps: list[dict[str, int]],
) -> None:
    """Persist a batch of Danbooru posts + their tags via the shared skeleton."""
    if not to_persist:
        return
    rows = [_danbooru_row(file_path_str, d_post, tag_map) for d_post, tag_map in zip(to_persist, precomputed_tag_maps, strict=True)]
    persist_posts_with_tags(db, rows)


def _insert_posts_and_links_tx(
    cur: sqlite3.Cursor,
    file_path_str: str,
    to_persist: list[DanbooruPost],
    precomputed_tag_maps: list[dict[str, int]],
) -> None:
    """Single-transaction posts + links insert for a batch of Danbooru posts.

    Retained (delegating to the shared core) because the characterization test
    drives this exact signature directly on a cursor.
    """
    rows = [_danbooru_row(file_path_str, d_post, tag_map) for d_post, tag_map in zip(to_persist, precomputed_tag_maps, strict=True)]
    _insert_posts_tx(cur, rows)


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
