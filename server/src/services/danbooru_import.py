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
import contextlib
import functools
import sqlite3
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import shared
from shared import logger
from utils import from_rating_to_int, resolve_source

if TYPE_CHECKING:
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


@dataclass
class DanbooruDownloadStats:
    total: int
    with_url: int
    filtered: int
    downloaded: int
    skipped: int
    failed: int


async def import_danbooru_posts(  # noqa: PLR0913
    *,
    client: DanbooruClient,
    type_to_group_id: dict[str, int],
    db: DB,
    tags: str,
    limit: int = _DEFAULT_LISTING_LIMIT,
    executor: Executor | None = None,
) -> DanbooruDownloadStats:
    """Download posts for ``tags`` from Danbooru and persist the new ones.

    The shared ``client`` and ``type_to_group_id`` come from startup state (see
    the module docstring); the DB-membership pre-check that short-circuits the
    download threadpool is the ``to_persist`` filter below. ``executor`` is the
    dedicated Danbooru thread pool — passing ``None`` falls back to asyncio's
    default pool (kept so the test suite can call this without app state).
    """
    danbooru_dir = shared.target_dir / "danbooru"
    save_dir = danbooru_dir / _safe_dir_name(tags)
    posts_orig = await _in_executor(executor, client.get_posts, tags=tags, limit=limit)
    posts_with_url = [p for p in posts_orig if p.file_url]
    logger.info(f"Fetched {len(posts_with_url)} available posts ({len(posts_orig)} total)")

    filtered = [p for p in posts_with_url if p.file_url and p.file_ext and p.file_ext.lower() in SUPPORTED_IMAGE_EXTS]
    await _in_executor(executor, save_dir.mkdir, parents=True, exist_ok=True)
    file_path_str = save_dir.relative_to(shared.target_dir).as_posix()

    def _names_with_manual_tags() -> set[str]:
        # Worker-thread-local cursor: ``db.cursor()`` returns a cursor on
        # *this* thread's connection. The event-loop-thread connection is
        # shared by every concurrent request, so doing BEGIN/COMMIT on it
        # makes concurrent imports trample each other's transactions.
        #
        # Dedup on "already has a manual (is_auto=0) tag", NOT merely "the post
        # row exists": a file can land in the DB tag-less first — folder-sync
        # reconciliation (``PostRepo.create_paths``) inserts a bare row for any
        # file already on disk, and a DB reset / snapshot rollback can leave
        # files behind without their ``post_has_tag`` links. Keying on
        # post-existence would skip those bare rows forever (their file_name is
        # "present"), so the Danbooru tags never get written. Keying on
        # manual-tag presence lets a re-run backfill them.
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

    tagged_names = await _in_executor(executor, _names_with_manual_tags)
    to_persist = [p for p in filtered if str(p.id) not in tagged_names]
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
        with_url=len(posts_with_url),
        filtered=len(filtered),
        downloaded=dl_stats.get("downloaded", 0),
        skipped=(len(filtered) - len(to_persist)) + dl_stats.get("skipped", 0),
        failed=dl_stats.get("failed", 0),
    )


def _persist_danbooru_batch(
    db: DB,
    file_path_str: str,
    to_persist: list[DanbooruPost],
    precomputed_tag_maps: list[dict[str, int]],
) -> None:
    """Persist a batch of Danbooru posts + their tags in two transactions.

    Called on a pool worker thread (via ``_in_executor``) — ``db.cursor()``
    therefore returns a cursor on *this worker thread's* SQLite connection, not
    the event-loop thread's. That isolation matters: transactions in sqlite3 are
    connection-scoped, so if all concurrent requests shared one connection,
    one worker's ``_safe_rollback`` could (and did) rip a sibling worker's
    in-flight BEGIN out from under it — the ``cannot commit - no transaction
    is active`` failure mode.

    Split rationale: when concurrent /download-from-danbooru requests all
    insert overlapping tags, the commit-time uniqueness check on `tags(name)`
    aborts one of them. Running tag inserts in their own short transaction
    keeps that retry surface tiny and prevents replay of the (much larger)
    posts + post_has_tag work each time tags happen to conflict.

    Each transaction uses ON CONFLICT for in-snapshot duplicates and a
    bounded retry loop for commit-time conflicts that only show up against
    rows committed by other transactions after our snapshot was taken.
    """
    if not to_persist:
        return
    cur = db.cursor()
    try:
        # Phase A: globally-deduped tag upsert in its own short transaction.
        all_tags: dict[str, int] = {}
        for tag_map in precomputed_tag_maps:
            for name, gid in tag_map.items():
                all_tags.setdefault(name, gid)
        if all_tags:
            _run_with_retry(cur, "tags", lambda: _insert_tags_tx(cur, all_tags))

        # Phase B: posts + post_has_tag in their own transaction. The tags they
        # reference are now committed by phase A, so concurrent writers can't
        # make this transaction wait on them.
        _run_with_retry(
            cur,
            "posts",
            lambda: _insert_posts_and_links_tx(cur, file_path_str, to_persist, precomputed_tag_maps),
        )
    finally:
        cur.close()


def _run_with_retry(
    cur: sqlite3.Cursor,
    label: str,
    fn: Callable[[], None],
    *,
    max_attempts: int = 5,
) -> None:
    """Retry on SQLite ``database is locked`` while another writer holds it.

    With WAL mode and a single backend process the writer lock is short-lived,
    but the startup backfill task can collide with download_from_danbooru
    requests; retry a few times before giving up.
    """
    for attempt in range(1, max_attempts + 1):
        try:
            fn()
        except sqlite3.OperationalError as exc:
            _safe_rollback(cur)
            msg = str(exc).lower()
            if "locked" not in msg and "busy" not in msg:
                raise
            if attempt == max_attempts:
                raise
            logger.warning(
                f"Danbooru {label} write contention (attempt {attempt}/{max_attempts}): {exc}; retrying",
            )
        except Exception:
            _safe_rollback(cur)
            raise
        else:
            return


def _insert_tags_tx(cur: sqlite3.Cursor, all_tags: dict[str, int]) -> None:
    cur.execute("BEGIN")
    cur.executemany(
        "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
        list(all_tags.items()),
    )
    cur.execute("COMMIT")


def _insert_posts_and_links_tx(
    cur: sqlite3.Cursor,
    file_path_str: str,
    to_persist: list[DanbooruPost],
    precomputed_tag_maps: list[dict[str, int]],
) -> None:
    cur.execute("BEGIN")
    post_tag_pairs: list[tuple[int, dict[str, int]]] = []
    for d_post, tag_map in zip(to_persist, precomputed_tag_maps, strict=True):
        cur.execute(
            """
            INSERT INTO posts(file_path, file_name, extension, source, rating, published_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (file_path, file_name, extension)
            DO UPDATE SET source = excluded.source,
                          published_at = excluded.published_at,
                          updated_at = CURRENT_TIMESTAMP
            RETURNING id
            """,
            [
                file_path_str,
                str(d_post.id),
                d_post.file_ext,
                resolve_source(d_post.source, f"https://danbooru.donmai.us/posts/{d_post.id}"),
                from_rating_to_int(d_post.rating),
                d_post.created_at,
            ],
        )
        # RETURNING fires for both INSERT (new post) and the DO UPDATE branch
        # (a pre-existing tag-less row being backfilled), so we get the id
        # either way and the post_has_tag upsert below attaches the tags.
        row = cur.fetchone()
        if row:
            post_tag_pairs.append((int(row[0]), tag_map))

    # (post_id, tag_name) is unique within this batch — each post_id appears
    # once and per-post names were deduped via dict in the pre-compute step.
    post_tag_rows = [(post_id, name) for post_id, tag_map in post_tag_pairs for name in tag_map]
    if post_tag_rows:
        cur.executemany(
            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
            post_tag_rows,
        )
    cur.execute("COMMIT")


def _safe_rollback(cur: sqlite3.Cursor) -> None:
    """ROLLBACK that swallows the 'no transaction is active' case."""
    with contextlib.suppress(sqlite3.OperationalError):
        cur.execute("ROLLBACK")


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
