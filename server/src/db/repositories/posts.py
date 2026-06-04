"""PostRepo — async Repository over the ``posts`` table (core CRUD only).

Read-model assembly (detail/list/search), filtered counts/aggregates, and the
per-table concerns that used to live here have moved out:

- listing / search / counts / aggregates → ``db.queries.post_query.PostQueryService``
- tag association (add/remove/bulk) → ``db.repositories.tags.TagRepo``
- waifu / aesthetic scores → ``db.repositories.scores.ScoreRepo``
- dominant-color palette fetch → ``db.repositories.colors.ColorRepo``
- process-failure blacklist → ``db.repositories.failures.FailureRepo``

What remains is the ``posts`` row lifecycle: fetch-by-id(s)/path, create,
single/bulk field updates, rotate-geometry refresh, touch, and delete.

Each public method is ``async def`` and uses ``asyncio.to_thread`` to push the
synchronous SQLite calls onto a worker thread. ``self.cur`` is a real
``sqlite3.Cursor`` issued by ``DB.cursor()``; ``DB._new_connection`` sets
``check_same_thread=False`` so the cursor can be used from those worker threads.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Any

import sqlite_vec

import shared
from db.entities import POST_COLUMNS, Post
from db.filters import BULK_UPDATABLE_FIELDS, UPDATABLE_FIELDS
from db.helpers import fetch_all_as, fetch_one_as, sql_placeholders

if TYPE_CHECKING:
    import sqlite3


class PostRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    # ─── Read single / many ──────────────────────────────────────────
    async def get(self, post_id: int) -> Post | None:
        def _impl() -> Post | None:
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts WHERE id = ?",  # noqa: S608
                [post_id],
            )
            return fetch_one_as(self.cur, Post)

        return await asyncio.to_thread(_impl)

    async def get_many(self, post_ids: list[int]) -> dict[int, Post]:
        """Fetch many posts by id in one round-trip; returns ``{id: Post}``.

        Backfill workers (basics / embedding / tagger / waifu) used to call
        ``get(pid)`` inside a per-batch loop, which is N round-trips per
        batch. This collapses them into one SELECT.
        """
        if not post_ids:
            return {}

        def _impl() -> dict[int, Post]:
            placeholders = sql_placeholders(post_ids)
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts WHERE id IN ({placeholders})",  # noqa: S608
                post_ids,
            )
            return {p.id: p for p in fetch_all_as(self.cur, Post)}

        return await asyncio.to_thread(_impl)

    async def get_by_path(self, file_path: str, file_name: str, extension: str) -> Post | None:
        def _impl() -> Post | None:
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts "  # noqa: S608
                "WHERE file_path = ? AND file_name = ? AND extension = ?",
                [file_path, file_name, extension],
            )
            return fetch_one_as(self.cur, Post)

        return await asyncio.to_thread(_impl)

    # ─── Mutation: single field ───────────────────────────────────────
    async def update_field(self, post_id: int, field: str, value: Any) -> bool:
        """Update a whitelisted scalar column. Returns ``True`` if a row matched.

        Callers that need the new state should fetch it themselves (e.g. via
        ``PostQueryService.get_detail``) — this avoids a post-update SELECT.
        """
        if field not in UPDATABLE_FIELDS:
            msg = f"Field is not whitelisted for update: {field}"
            raise ValueError(msg)

        def _impl() -> bool:
            self.cur.execute(
                f"UPDATE posts SET {field} = ?, updated_at = CURRENT_TIMESTAMP, "  # noqa: S608
                "last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?",
                [value, post_id],
            )
            matched = self.cur.rowcount > 0
            if field == "score":
                # Scoring a canonical post mirrors the score onto *every* member
                # of its near-duplicate group, so the whole group always shares
                # the representative's score (members are hidden duplicates).
                # This overwrites any score a member was given individually, and
                # a score of 0 clears the group too.
                self.cur.execute(
                    "UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP "
                    "WHERE canonical_post_id = ?",
                    [value, post_id],
                )
            return matched

        return await asyncio.to_thread(_impl)

    async def bulk_update_field(self, ids: list[int], field: str, value: Any) -> None:
        if field not in BULK_UPDATABLE_FIELDS:
            msg = f"Field is not whitelisted for bulk update: {field}"
            raise ValueError(msg)
        if not ids:
            return

        def _impl() -> None:
            placeholders = sql_placeholders(ids)
            self.cur.execute(
                f"UPDATE posts SET {field} = ?, updated_at = CURRENT_TIMESTAMP, "  # noqa: S608
                f"last_accessed_at = CURRENT_TIMESTAMP "
                f"WHERE id IN ({placeholders})",
                [value, *ids],
            )
            if field == "score":
                # Mirror the score onto every member of each canonical's group
                # (see update_field): the hidden group always shares the
                # representative's score, overwriting any individual member score
                # (a score of 0 clears the group too).
                self.cur.execute(
                    f"UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP "  # noqa: S608
                    f"WHERE canonical_post_id IN ({placeholders})",
                    [value, *ids],
                )

        await asyncio.to_thread(_impl)

    async def touch_accessed(self, post_id: int) -> bool:
        """Bump ``last_accessed_at`` for the Recently view.

        Returns ``True`` if the row existed. Does not touch ``updated_at`` —
        viewing is not an edit.
        """

        def _impl() -> bool:
            self.cur.execute(
                "UPDATE posts SET last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?",
                [post_id],
            )
            return self.cur.rowcount > 0

        return await asyncio.to_thread(_impl)

    # ─── Mutation: rotate (geometry refresh after image rotation) ─────
    async def update_for_rotate(
        self,
        post_id: int,
        *,
        sha256: str,
        width: int,
        height: int,
        arthash: str | None,
    ) -> None:
        def _impl() -> None:
            self.cur.execute(
                """
                UPDATE posts
                SET sha256 = ?, width = ?, height = ?, arthash = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                [sha256, width, height, arthash, post_id],
            )

        await asyncio.to_thread(_impl)

    # ─── Mutation: grouping (near-duplicate canonical pointer) ─────────
    async def set_canonical(self, member_ids: list[int], canonical_id: int) -> None:
        """Point ``member_ids`` at ``canonical_id`` (hide them as group members).

        The caller (the dedup service) guarantees ``canonical_id`` is itself
        canonical and not in ``member_ids``, so this never builds a chain or a
        self-loop. The UPDATE fires the canonical-grouping trigger that keeps
        ``tags.post_count`` counting only visible (canonical) posts.
        """
        if not member_ids:
            return

        def _impl() -> None:
            placeholders = sql_placeholders(member_ids)
            self.cur.execute(
                f"UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP "  # noqa: S608
                f"WHERE id IN ({placeholders})",
                [canonical_id, *member_ids],
            )

        await asyncio.to_thread(_impl)

    async def clear_canonical(self, ids: list[int]) -> None:
        """Ungroup ``ids`` — promote them back to standalone canonical posts."""
        if not ids:
            return

        def _impl() -> None:
            placeholders = sql_placeholders(ids)
            self.cur.execute(
                f"UPDATE posts SET canonical_post_id = NULL, updated_at = CURRENT_TIMESTAMP "  # noqa: S608
                f"WHERE id IN ({placeholders})",
                ids,
            )

        await asyncio.to_thread(_impl)

    async def replace_all_groups(self, assignments: list[tuple[int, int]]) -> None:
        """Atomically replace every grouping pointer with ``assignments``.

        ``assignments`` is the complete new grouping as ``(member_id,
        canonical_id)`` pairs; posts not listed become (stay) canonical. Clear +
        reapply runs in ONE transaction so a reader never observes the
        half-rebuilt state — the previous reset-then-set-per-group pattern left
        a minutes-long window (GPU pass + 20k+ autocommit UPDATEs) where every
        member was visible in listings. The UPDATEs still fire the
        canonical-grouping triggers that keep ``tags.post_count`` canonical-only.
        """

        def _impl() -> None:
            self.cur.execute("BEGIN")
            try:
                self.cur.execute(
                    "UPDATE posts SET canonical_post_id = NULL WHERE canonical_post_id IS NOT NULL",
                )
                self.cur.executemany(
                    "UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    [(canonical_id, member_id) for member_id, canonical_id in assignments],
                )
                self.cur.execute("COMMIT")
            except Exception:
                self.cur.execute("ROLLBACK")
                raise

        await asyncio.to_thread(_impl)

    async def make_canonical(self, post_id: int) -> bool:
        """Promote ``post_id`` to be its group's canonical (the "set as cover").

        Re-points the old canonical and every sibling member at ``post_id`` and
        clears ``post_id``'s own pointer. No-op (returns False) if the post does
        not exist or is already canonical.
        """

        def _impl() -> bool:
            self.cur.execute("SELECT canonical_post_id FROM posts WHERE id = ?", [post_id])
            row = self.cur.fetchone()
            if row is None or row[0] is None:
                return False
            current = row[0]
            # Old canonical + its other members all now point at post_id.
            self.cur.execute(
                "UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP "
                "WHERE (id = ? OR canonical_post_id = ?) AND id != ?",
                [post_id, current, current, post_id],
            )
            # post_id itself becomes canonical (visible).
            self.cur.execute(
                "UPDATE posts SET canonical_post_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [post_id],
            )
            return True

        return await asyncio.to_thread(_impl)

    # ─── Mutation: delete ─────────────────────────────────────────────
    async def delete_many(self, ids: list[int]) -> None:
        """Delete posts and all dependent rows, then remove files from disk.

        ``ON DELETE CASCADE`` (declared in 0001_initial.sql) handles
        ``post_has_color`` / ``post_waifu_scores`` automatically.
        ``post_vectors_siglip2`` is a vec0 virtual table and doesn't participate
        in foreign-key cascades — clear it explicitly. ``post_has_tag`` is also
        deleted explicitly *before* the posts row so the canonical-aware
        ``tags.post_count`` trigger (migration 0009) sees each post's real
        canonical status instead of racing the FK cascade.
        """
        if not ids:
            return

        def _impl() -> list[str]:
            placeholders = sql_placeholders(ids)
            # Collect file paths before deleting rows.
            self.cur.execute(
                f"SELECT full_path FROM posts WHERE id IN ({placeholders})",  # noqa: S608
                ids,
            )
            full_paths = [row[0] for row in self.cur.fetchall()]
            # Explicit, ahead of the posts delete, so trg_post_has_tag_count_ad
            # fires while the post row still exists (correct canonical guard).
            self.cur.execute(
                f"DELETE FROM post_has_tag WHERE post_id IN ({placeholders})",  # noqa: S608
                ids,
            )
            # vec0 virtual table — no FK CASCADE
            self.cur.execute(
                f"DELETE FROM post_vectors_siglip2 WHERE post_id IN ({placeholders})",  # noqa: S608
                ids,
            )
            self.cur.execute(
                f"DELETE FROM posts WHERE id IN ({placeholders})",  # noqa: S608
                ids,
            )
            return full_paths

        full_paths = await asyncio.to_thread(_impl)

        def _unlink_files() -> None:
            for fp in full_paths:
                relative = Path(fp)
                (shared.target_dir / relative).unlink(missing_ok=True)
                (shared.thumbnails_dir / relative).unlink(missing_ok=True)

        await asyncio.to_thread(_unlink_files)

    async def delete_one(self, post_id: int) -> None:
        await self.delete_many([post_id])

    # ─── Create ───────────────────────────────────────────────────────
    async def create_paths(self, triples: list[tuple[str, str, str]]) -> None:
        """Bulk-insert posts from ``(file_path, file_name, extension)``.

        Used by the filesystem-reconciliation path which only knows the path
        components — every other column gets its schema default. Callers don't
        need the resulting Post rows back, so we skip the per-row RETURNING +
        re-SELECT round-trip that ``create()`` does.
        """
        if not triples:
            return

        def _impl() -> None:
            self.cur.executemany(
                "INSERT INTO posts(file_path, file_name, extension) VALUES (?, ?, ?)",
                triples,
            )

        await asyncio.to_thread(_impl)

    async def create(  # noqa: PLR0913
        self,
        *,
        file_path: str,
        file_name: str,
        extension: str,
        source: str = "",
        width: int = 0,
        height: int = 0,
        size: int = 0,
        sha256: str = "",
        meta: str = "",
        caption: str = "",
        description: str = "",
        arthash: str | None = None,
        dominant_color: list[float] | None = None,
        published_at: Any = None,
    ) -> Post:
        dom_blob = sqlite_vec.serialize_float32(list(dominant_color)) if dominant_color is not None else None

        def _impl() -> Post:
            self.cur.execute(
                """
                INSERT INTO posts(
                    file_path, file_name, extension, source, width, height,
                    size, sha256, meta, caption, description, arthash,
                    dominant_color, published_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                [
                    file_path,
                    file_name,
                    extension,
                    source,
                    width,
                    height,
                    size,
                    sha256,
                    meta,
                    caption,
                    description,
                    arthash,
                    dom_blob,
                    published_at,
                ],
            )
            row = self.cur.fetchone()
            if row is None:
                msg = "Post insert did not return an id"
                raise RuntimeError(msg)
            new_id = row[0]
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts WHERE id = ?",  # noqa: S608
                [new_id],
            )
            post = fetch_one_as(self.cur, Post)
            if post is None:
                msg = "Newly inserted post not found"
                raise RuntimeError(msg)
            return post

        return await asyncio.to_thread(_impl)

    async def upsert_from_danbooru(  # noqa: PLR0913
        self,
        *,
        file_path: str,
        file_name: str,
        extension: str,
        source: str,
        rating: int,
        published_at: Any,
    ) -> int | None:
        """INSERT or UPDATE-source-and-published-at; return the post id."""

        def _impl() -> int | None:
            self.cur.execute(
                """
                INSERT INTO posts(file_path, file_name, extension, source, rating, published_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (file_path, file_name, extension)
                DO UPDATE SET source = excluded.source,
                              published_at = excluded.published_at,
                              updated_at = CURRENT_TIMESTAMP
                RETURNING id
                """,
                [file_path, file_name, extension, source, rating, published_at],
            )
            row = self.cur.fetchone()
            return int(row[0]) if row else None

        return await asyncio.to_thread(_impl)
