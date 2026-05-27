"""Download a Danbooru tag search and persist the new posts + their tags.

Lifted out of ``CommandController.download_from_danbooru`` so the HTTP handler
is a thin call: fetch → filter to supported images → skip what's already in the
DB → persist (tags, then posts+links, each in its own retried transaction) →
download the files. The transaction/retry shape is load-bearing under
concurrent imports; it is preserved verbatim here.
"""

from __future__ import annotations

import asyncio
import contextlib
import sqlite3
from dataclasses import dataclass
from typing import TYPE_CHECKING

import shared
from utils import from_rating_to_int, logger

if TYPE_CHECKING:
    from collections.abc import Callable

    from danbooru import DanbooruClient, DanbooruPost
    from db import DB

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


async def import_danbooru_posts(
    *,
    client: DanbooruClient,
    type_to_group_id: dict[str, int],
    db: DB,
    tags: str,
) -> DanbooruDownloadStats:
    """Download posts for ``tags`` from Danbooru and persist the new ones.

    Optimization notes:
    - Shared ``DanbooruClient`` and the canonical tag-group map both come from
      startup state, so each call avoids the API-client construction + five
      tag-group upsert round-trips it would otherwise repeat.
    - DB lookup first, then download only the subset of ``filtered`` not yet in
      the DB — under normal operation DB membership implies file-on-disk, so
      this short-circuits the 16-worker threadpool when nothing is new.
    """
    danbooru_dir = shared.target_dir / "danbooru"
    save_dir = danbooru_dir / _safe_dir_name(tags)
    posts_orig = await asyncio.to_thread(client.get_posts, tags=tags, limit=99999)
    posts_with_url = [p for p in posts_orig if p.file_url]
    logger.info(f"Fetched {len(posts_with_url)} available posts ({len(posts_orig)} total)")

    filtered = [
        p
        for p in posts_with_url
        if p.file_url and p.file_ext and p.file_ext.lower() in SUPPORTED_IMAGE_EXTS
    ]
    await asyncio.to_thread(save_dir.mkdir, parents=True, exist_ok=True)
    file_path_str = save_dir.relative_to(shared.target_dir).as_posix()

    def _existing_post_names() -> set[str]:
        # Worker-thread-local cursor: ``db.cursor()`` returns a cursor on
        # *this* thread's connection. The event-loop-thread connection is
        # shared by every concurrent request, so doing BEGIN/COMMIT on it
        # makes concurrent imports trample each other's transactions.
        cur = db.cursor()
        try:
            cur.execute(
                "SELECT file_name FROM posts WHERE file_path = ?",
                [file_path_str],
            )
            return {row[0] for row in cur.fetchall()}
        finally:
            cur.close()

    existing_names = await asyncio.to_thread(_existing_post_names)
    to_persist = [p for p in filtered if str(p.id) not in existing_names]
    logger.info(f"Persisting {len(to_persist)} new posts ({len(filtered) - len(to_persist)} already in DB)")

    # Pre-compute per-post tag maps (in-memory, no DB calls).
    precomputed_tag_maps = [_build_tag_to_group(p, type_to_group_id) for p in to_persist]

    await asyncio.to_thread(
        _persist_danbooru_batch,
        db,
        file_path_str,
        to_persist,
        precomputed_tag_maps,
    )

    # Pass `to_persist` (not `filtered`) to download_posts: every entry in
    # `filtered \ to_persist` is already in the DB, which under normal
    # operation means its file is on disk. Skipping it avoids a wasted
    # exists() round trip per post, and short-circuits the 16-worker
    # threadpool entirely when nothing new needs downloading.
    if to_persist:
        dl_stats = await asyncio.to_thread(client.download_posts, to_persist, save_dir)
    else:
        dl_stats = {"downloaded": 0, "skipped": 0, "failed": 0}

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

    Called from ``asyncio.to_thread`` — ``db.cursor()`` therefore returns a
    cursor on *this worker thread's* SQLite connection, not the event-loop
    thread's. That isolation matters: transactions in sqlite3 are
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
                f"https://danbooru.donmai.us/posts/{d_post.id}",
                from_rating_to_int(d_post.rating),
                d_post.created_at,
            ],
        )
        row = cur.fetchone()
        if row:
            post_tag_pairs.append((int(row[0]), tag_map))

    # (post_id, tag_name) is unique within this batch — each post_id appears
    # once and per-post names were deduped via dict in the pre-compute step.
    post_tag_rows = [(post_id, name) for post_id, tag_map in post_tag_pairs for name in tag_map]
    if post_tag_rows:
        cur.executemany(
            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) "
            "ON CONFLICT DO NOTHING",
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
