"""PostRepo — async Repository over the `posts` table (and joined tables).

Each public method is ``async def`` and uses ``asyncio.to_thread`` to push
synchronous SQLite calls onto a worker thread, preserving Litestar's event
loop responsiveness even though sqlite3 has no native async driver.

Cursor model (post-DuckDB → SQLite migration):
- ``self.cur`` is a real ``sqlite3.Cursor`` issued by ``DB.cursor()`` for the
  thread that constructed this repository (typically the ``provide_post_repo``
  DI provider in ``app.py``).
- ``DB._new_connection`` sets ``check_same_thread=False`` so the cursor can be
  used from worker threads spawned by ``asyncio.to_thread``. SQLite serializes
  access internally; the WAL journal makes that cheap for our read-heavy
  workload.
"""

from __future__ import annotations

import asyncio
import struct
from typing import TYPE_CHECKING, Any

import sqlite_vec

from db.entities import (
    POST_COLUMNS,
    Post,
)
from db.helpers import fetch_all_as, fetch_all_dicts, fetch_one_as, fetch_one_dict

if TYPE_CHECKING:
    import sqlite3


SIMPLE_POST_COLUMNS = (
    "id, file_path, file_name, extension, rating, width, height, "
    "aspect_ratio, dominant_color, thumbhash, sha256"
)


_ORDERABLE_COLUMNS = {"id", "score", "rating", "created_at", "published_at", "file_name"}


def _decode_dominant_color_blob(value: Any) -> list[float] | None:
    """Convert an sqlite-vec serialized FLOAT[3] BLOB to a list[float].

    Returns ``None`` for NULL / empty inputs and passes through values that
    are already lists (e.g. when an in-memory value short-circuits the DB).
    """
    if value is None or isinstance(value, list):
        return value
    raw = bytes(value)
    n = len(raw) // 4
    if n == 0:
        return None
    return list(struct.unpack(f"{n}f", raw))


def _decode_dominant_colors_in(rows: list[dict]) -> None:
    """Decode the ``dominant_color`` field on a batch of result dicts in place."""
    for r in rows:
        if "dominant_color" in r:
            r["dominant_color"] = _decode_dominant_color_blob(r["dominant_color"])


class PostRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    # ─── Read single ──────────────────────────────────────────────────
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
            placeholders = ",".join("?" * len(post_ids))
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts WHERE id IN ({placeholders})",  # noqa: S608
                post_ids,
            )
            return {p.id: p for p in fetch_all_as(self.cur, Post)}

        return await asyncio.to_thread(_impl)

    async def get_detail(self, post_id: int) -> dict | None:
        """Return a dict ready for ``PostDetailPublic.model_validate`` —
        includes joined tags (ordered by group_name_order), colors, and
        waifu_score. Returns ``None`` if the post doesn't exist.
        """

        def _impl() -> dict | None:
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts WHERE id = ?",  # noqa: S608
                [post_id],
            )
            post = fetch_one_dict(self.cur)
            if post is None:
                return None
            _decode_dominant_colors_in([post])
            # tags (ordered by canonical group order)
            self.cur.execute(
                """
                SELECT
                    pht.is_auto                  AS is_auto,
                    t.name                       AS name,
                    t.created_at                 AS created_at,
                    t.updated_at                 AS updated_at,
                    tg.id                        AS group_id,
                    tg.name                      AS group_name,
                    tg.color                     AS group_color
                FROM post_has_tag pht
                JOIN tags t ON t.name = pht.tag_name
                LEFT JOIN tag_groups tg ON tg.id = t.group_id
                WHERE pht.post_id = ?
                ORDER BY
                    CASE COALESCE(tg.name, '')
                        WHEN 'artist'    THEN 0
                        WHEN 'copyright' THEN 1
                        WHEN 'character' THEN 2
                        WHEN 'general'   THEN 3
                        WHEN 'meta'      THEN 4
                        ELSE 5
                    END,
                    t.name
                """,
                [post_id],
            )
            tag_rows = fetch_all_dicts(self.cur)
            tags = [
                {
                    "is_auto": bool(r["is_auto"]),
                    "tag_info": {
                        "name": r["name"],
                        "created_at": r["created_at"],
                        "updated_at": r["updated_at"],
                        "group": (
                            {
                                "id": r["group_id"],
                                "name": r["group_name"],
                                "color": r["group_color"],
                            }
                            if r["group_id"] is not None
                            else None
                        ),
                    },
                }
                for r in tag_rows
            ]
            # colors
            self.cur.execute(
                'SELECT "order", color FROM post_has_color WHERE post_id = ? ORDER BY "order"',
                [post_id],
            )
            colors = fetch_all_dicts(self.cur)
            # waifu score
            self.cur.execute(
                "SELECT score FROM post_waifu_scores WHERE post_id = ?",
                [post_id],
            )
            ws_row = self.cur.fetchone()
            waifu_score = {"score": ws_row[0]} if ws_row else None

            return {**post, "tags": tags, "colors": colors, "waifu_score": waifu_score}

        return await asyncio.to_thread(_impl)

    async def get_simple_by_id(self, post_id: int) -> dict | None:
        def _impl() -> dict | None:
            self.cur.execute(
                f"SELECT {SIMPLE_POST_COLUMNS} FROM posts WHERE id = ?",  # noqa: S608
                [post_id],
            )
            post = fetch_one_dict(self.cur)
            if post is None:
                return None
            _decode_dominant_colors_in([post])
            self.cur.execute(
                'SELECT "order", color FROM post_has_color WHERE post_id = ? ORDER BY "order"',
                [post_id],
            )
            return {**post, "colors": fetch_all_dicts(self.cur)}

        return await asyncio.to_thread(_impl)

    # ─── Read many ────────────────────────────────────────────────────
    async def list_paginated(self, start: int, limit: int) -> tuple[list[dict], int | None]:
        """Return (items_as_detail_dicts, next_cursor)."""

        def _impl() -> tuple[list[dict], int | None]:
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts WHERE id >= ? ORDER BY id ASC LIMIT ?",  # noqa: S608
                [start, limit + 1],
            )
            posts = fetch_all_dicts(self.cur)
            _decode_dominant_colors_in(posts)
            next_cursor: int | None = None
            if len(posts) > limit:
                next_cursor = posts[-1]["id"]
                posts = posts[:-1]
            # detail (tags, colors, waifu_score) per row
            details: list[dict] = []
            for p in posts:
                pid = p["id"]
                self.cur.execute(
                    """
                    SELECT pht.is_auto, t.name, t.created_at, t.updated_at,
                           tg.id AS group_id, tg.name AS group_name, tg.color AS group_color
                    FROM post_has_tag pht
                    JOIN tags t ON t.name = pht.tag_name
                    LEFT JOIN tag_groups tg ON tg.id = t.group_id
                    WHERE pht.post_id = ?
                    ORDER BY t.name
                    """,
                    [pid],
                )
                tag_rows = fetch_all_dicts(self.cur)
                tags = [
                    {
                        "is_auto": bool(r["is_auto"]),
                        "tag_info": {
                            "name": r["name"],
                            "created_at": r["created_at"],
                            "updated_at": r["updated_at"],
                            "group": (
                                {"id": r["group_id"], "name": r["group_name"], "color": r["group_color"]}
                                if r["group_id"] is not None
                                else None
                            ),
                        },
                    }
                    for r in tag_rows
                ]
                self.cur.execute(
                    'SELECT "order", color FROM post_has_color WHERE post_id = ? ORDER BY "order"',
                    [pid],
                )
                colors = fetch_all_dicts(self.cur)
                self.cur.execute(
                    "SELECT score FROM post_waifu_scores WHERE post_id = ?",
                    [pid],
                )
                ws = self.cur.fetchone()
                details.append(
                    {
                        **p,
                        "tags": tags,
                        "colors": colors,
                        "waifu_score": ({"score": ws[0]} if ws else None),
                    },
                )
            return details, next_cursor

        return await asyncio.to_thread(_impl)

    async def search_simple(  # noqa: PLR0913
        self,
        *,
        rating: tuple[int, ...] | None = None,
        score: tuple[int, ...] | None = None,
        tags: tuple[str, ...] | None = None,
        extension: tuple[str, ...] | None = None,
        folder: str | None = None,
        lab: tuple[float, float, float] | None = None,
        waifu_score_range: tuple[float, float] | None = None,
        waifu_score_levels: tuple[str, ...] | None = None,
        order_by: str | None = None,
        order: str = "desc",
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """Search posts, returning rows ready for ``PostSimplePublic``.

        ``lab`` triggers brute-force L2 distance ordering over dominant_color
        via sqlite-vec's ``vec_distance_L2`` — no separate index needed since
        the dataset is small and the column is only 3-d.
        ``order_by`` is one of the whitelisted columns; ``order`` is
        ``asc`` | ``desc`` | ``random``.
        """

        def _impl() -> list[dict]:
            where_clauses, params, joins = _build_filter_clauses(
                rating=rating,
                score=score,
                tags=tags,
                extension=extension,
                folder=folder,
                waifu_score_range=waifu_score_range,
                waifu_score_levels=waifu_score_levels,
            )

            select_cols = (
                "SELECT p.id, p.file_path, p.file_name, p.extension, p.rating, "
                "p.width, p.height, p.aspect_ratio, p.dominant_color, "
                "p.thumbhash, p.sha256"
            )
            from_clause = "FROM posts p" + ("\n" + "\n".join(joins) if joins else "")
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

            if lab is not None:
                lab_blob = sqlite_vec.serialize_float32(list(lab))
                sql = (
                    f"{select_cols}, "
                    f"vec_distance_L2(p.dominant_color, ?) AS _dist "
                    f"{from_clause} "
                    f"{(where_sql + ' AND ') if where_sql else 'WHERE '}"
                    f"p.dominant_color IS NOT NULL "
                    "ORDER BY _dist "
                    "LIMIT ? OFFSET ?"
                )
                self.cur.execute(sql, [lab_blob, *params, limit, offset])
            else:
                order_sql = ""
                if order_by and order_by in _ORDERABLE_COLUMNS:
                    if order == "random":
                        order_sql = "ORDER BY random()"
                    else:
                        direction = "ASC" if order == "asc" else "DESC"
                        order_sql = f"ORDER BY p.{order_by} {direction}"
                sql = (
                    f"{select_cols} {from_clause} {where_sql} {order_sql} LIMIT ? OFFSET ?"
                )
                self.cur.execute(sql, [*params, limit, offset])

            rows = fetch_all_dicts(self.cur)
            for r in rows:
                r.pop("_dist", None)
            _decode_dominant_colors_in(rows)
            ids = [r["id"] for r in rows]
            colors_by_post = self._fetch_colors_by_ids(ids)
            for r in rows:
                r["colors"] = colors_by_post.get(r["id"], [])
            return rows

        return await asyncio.to_thread(_impl)

    async def list_simple_by_ids_preserving_order(self, id_list: list[int]) -> list[dict]:
        """Return PostSimplePublic-shape rows in the same order as id_list."""

        def _impl() -> list[dict]:
            if not id_list:
                return []
            placeholders = ",".join("?" * len(id_list))
            self.cur.execute(
                f"SELECT {SIMPLE_POST_COLUMNS} FROM posts WHERE id IN ({placeholders})",  # noqa: S608
                id_list,
            )
            rows = fetch_all_dicts(self.cur)
            _decode_dominant_colors_in(rows)
            by_id = {r["id"]: r for r in rows}
            ordered = [by_id[i] for i in id_list if i in by_id]
            ids = [r["id"] for r in ordered]
            colors_by_post = self._fetch_colors_by_ids(ids)
            for r in ordered:
                r["colors"] = colors_by_post.get(r["id"], [])
            return ordered

        return await asyncio.to_thread(_impl)

    def _fetch_colors_by_ids(self, ids: list[int]) -> dict[int, list[dict]]:
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        self.cur.execute(
            f'SELECT post_id, "order", color FROM post_has_color '  # noqa: S608
            f'WHERE post_id IN ({placeholders}) ORDER BY post_id, "order"',
            ids,
        )
        result: dict[int, list[dict]] = {}
        for pid, order, color in self.cur.fetchall():
            result.setdefault(pid, []).append({"order": order, "color": color})
        return result

    # ─── Counts / aggregates ──────────────────────────────────────────
    async def count(self, **filters: Any) -> int:
        def _impl() -> int:
            where_clauses, params, joins = _build_filter_clauses(**filters)
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"SELECT count(p.id) FROM posts p {joins_sql} {where_sql}",  # noqa: S608
                params,
            )
            row = self.cur.fetchone()
            return int(row[0]) if row else 0

        return await asyncio.to_thread(_impl)

    async def count_by_waifu_bucket(self, **filters: Any) -> list[dict]:
        """Group posts into the 5 waifu-score buckets (S/A/B/C/D) plus UNSCORED."""

        def _impl() -> list[dict]:
            where_clauses, params, joins = _build_filter_clauses(**filters)
            if not any("post_waifu_scores" in j for j in joins):
                joins.append("LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id")
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"""
                SELECT
                    CASE
                        WHEN pws.post_id IS NULL THEN 'UNSCORED'
                        WHEN pws.score >= 8 THEN 'S'
                        WHEN pws.score >= 6 THEN 'A'
                        WHEN pws.score >= 4 THEN 'B'
                        WHEN pws.score >= 2 THEN 'C'
                        ELSE 'D'
                    END AS bucket,
                    count(*) AS count
                FROM posts p
                {joins_sql}
                {where_sql}
                GROUP BY bucket
                """,  # noqa: S608
                params,
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def count_by_column(self, column: str, **filters: Any) -> list[dict]:
        if column not in {"rating", "score", "extension"}:
            msg = f"Cannot group by unsafe column: {column}"
            raise ValueError(msg)

        def _impl() -> list[dict]:
            where_clauses, params, joins = _build_filter_clauses(**filters)
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"SELECT p.{column} AS {column}, count(*) AS count "  # noqa: S608
                f"FROM posts p {joins_sql} {where_sql} GROUP BY p.{column}",
                params,
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def aggregate_stats(self, **filters: Any) -> dict:
        """Aggregate post-quality stats for a filter (used by the footer)."""

        def _impl() -> dict:
            where_clauses, params, joins = _build_filter_clauses(**filters)
            if not any("post_waifu_scores" in j for j in joins):
                joins.append("LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id")
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"""
                SELECT
                    count(p.id) AS total,
                    AVG(CASE WHEN p.score > 0 THEN p.score END) AS avg_score,
                    count(CASE WHEN p.score > 0 THEN 1 END) AS scored_count,
                    AVG(pws.score) AS avg_waifu_score,
                    count(pws.post_id) AS waifu_count
                FROM posts p {joins_sql} {where_sql}
                """,  # noqa: S608
                params,
            )
            agg = fetch_one_dict(self.cur) or {}
            self.cur.execute(
                f"SELECT p.rating AS rating, count(*) AS count "  # noqa: S608
                f"FROM posts p {joins_sql} {where_sql} GROUP BY p.rating",
                params,
            )
            rating_rows = fetch_all_dicts(self.cur)
            return {
                "total": int(agg.get("total") or 0),
                "avg_score": agg.get("avg_score"),
                "scored_count": int(agg.get("scored_count") or 0),
                "avg_waifu_score": agg.get("avg_waifu_score"),
                "waifu_count": int(agg.get("waifu_count") or 0),
                "rating_distribution": [
                    {"rating": int(r["rating"] or 0), "count": int(r["count"])}
                    for r in rating_rows
                ],
            }

        return await asyncio.to_thread(_impl)

    # ─── Mutation: single field ───────────────────────────────────────
    async def update_field(self, post_id: int, field: str, value: Any) -> Post | None:
        if field not in {"score", "rating", "caption", "source", "description", "meta"}:
            msg = f"Field is not whitelisted for update: {field}"
            raise ValueError(msg)

        def _impl() -> Post | None:
            self.cur.execute(
                f"UPDATE posts SET {field} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",  # noqa: S608
                [value, post_id],
            )
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts WHERE id = ?",  # noqa: S608
                [post_id],
            )
            return fetch_one_as(self.cur, Post)

        return await asyncio.to_thread(_impl)

    async def bulk_update_field(self, ids: list[int], field: str, value: Any) -> None:
        if field not in {"score", "rating"}:
            msg = f"Field is not whitelisted for bulk update: {field}"
            raise ValueError(msg)
        if not ids:
            return

        def _impl() -> None:
            placeholders = ",".join("?" * len(ids))
            self.cur.execute(
                f"UPDATE posts SET {field} = ?, updated_at = CURRENT_TIMESTAMP "  # noqa: S608
                f"WHERE id IN ({placeholders})",
                [value, *ids],
            )

        await asyncio.to_thread(_impl)

    # ─── Mutation: rotate (geometry refresh after image rotation) ─────
    async def update_for_rotate(
        self,
        post_id: int,
        *,
        sha256: str,
        width: int,
        height: int,
        thumbhash: str | None,
    ) -> None:
        def _impl() -> None:
            self.cur.execute(
                """
                UPDATE posts
                SET sha256 = ?, width = ?, height = ?, thumbhash = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                [sha256, width, height, thumbhash, post_id],
            )

        await asyncio.to_thread(_impl)

    # ─── Mutation: delete ─────────────────────────────────────────────
    async def delete_many(self, ids: list[int]) -> None:
        """Delete posts and all dependent rows.

        ``ON DELETE CASCADE`` (declared in 0001_initial.sql) handles
        ``post_has_tag`` / ``post_has_color`` / ``post_waifu_scores``
        automatically. ``post_vectors`` is a vec0 virtual table and doesn't
        participate in foreign-key cascades — clear it explicitly.
        """
        if not ids:
            return

        def _impl() -> None:
            placeholders = ",".join("?" * len(ids))
            # vec0 virtual table — no FK CASCADE
            self.cur.execute(
                f"DELETE FROM post_vectors WHERE post_id IN ({placeholders})",  # noqa: S608
                ids,
            )
            self.cur.execute(
                f"DELETE FROM posts WHERE id IN ({placeholders})",  # noqa: S608
                ids,
            )

        await asyncio.to_thread(_impl)

    async def delete_one(self, post_id: int) -> None:
        await self.delete_many([post_id])

    # ─── Tag association ─────────────────────────────────────────────
    async def add_tag(self, post_id: int, tag_name: str) -> bool:
        """Return True if inserted, False if already existed."""

        def _impl() -> bool:
            self.cur.execute(
                "SELECT 1 FROM post_has_tag WHERE post_id = ? AND tag_name = ?",
                [post_id, tag_name],
            )
            if self.cur.fetchone():
                return False
            self.cur.execute(
                "INSERT INTO tags(name) VALUES(?) ON CONFLICT DO NOTHING",
                [tag_name],
            )
            self.cur.execute(
                "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES(?, ?, 0)",
                [post_id, tag_name],
            )
            return True

        return await asyncio.to_thread(_impl)

    async def remove_tag(self, post_id: int, tag_name: str) -> bool:
        """Return True if removed, False if didn't exist."""

        def _impl() -> bool:
            self.cur.execute(
                "DELETE FROM post_has_tag WHERE post_id = ? AND tag_name = ? RETURNING post_id",
                [post_id, tag_name],
            )
            return self.cur.fetchone() is not None

        return await asyncio.to_thread(_impl)

    async def set_tags_bulk(self, post_id: int, tag_names: list[str], *, is_auto: bool) -> None:
        """Insert tag rows + post_has_tag rows, ignoring duplicates."""
        if not tag_names:
            return

        def _impl() -> None:
            for name in tag_names:
                self.cur.execute(
                    "INSERT INTO tags(name) VALUES(?) ON CONFLICT DO NOTHING",
                    [name],
                )
                self.cur.execute(
                    "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES(?, ?, ?) "
                    "ON CONFLICT DO NOTHING",
                    [post_id, name, 1 if is_auto else 0],
                )

        await asyncio.to_thread(_impl)

    # ─── Create ───────────────────────────────────────────────────────
    async def create_paths(self, triples: list[tuple[str, str, str]]) -> None:
        """Bulk-insert posts from ``(file_path, file_name, extension)``.

        Used by the filesystem-reconciliation path which only knows the path
        components — every other column gets its schema default. Callers
        don't need the resulting Post rows back, so we skip the per-row
        RETURNING + re-SELECT round-trip that ``create()`` does.
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
        thumbhash: str | None = None,
        dominant_color: list[float] | None = None,
        published_at: Any = None,
    ) -> Post:
        dom_blob = (
            sqlite_vec.serialize_float32(list(dominant_color))
            if dominant_color is not None
            else None
        )

        def _impl() -> Post:
            self.cur.execute(
                """
                INSERT INTO posts(
                    file_path, file_name, extension, source, width, height,
                    size, sha256, meta, caption, description, thumbhash,
                    dominant_color, published_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                [
                    file_path, file_name, extension, source, width, height,
                    size, sha256, meta, caption, description, thumbhash,
                    dom_blob, published_at,
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

    # ─── Lookup helpers ──────────────────────────────────────────────
    async def get_by_path(
        self,
        file_path: str,
        file_name: str,
        extension: str,
    ) -> Post | None:
        def _impl() -> Post | None:
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts "  # noqa: S608
                "WHERE file_path = ? AND file_name = ? AND extension = ?",
                [file_path, file_name, extension],
            )
            return fetch_one_as(self.cur, Post)

        return await asyncio.to_thread(_impl)

    # ─── Waifu score ─────────────────────────────────────────────────
    async def get_waifu_score(self, post_id: int) -> float | None:
        def _impl() -> float | None:
            self.cur.execute(
                "SELECT score FROM post_waifu_scores WHERE post_id = ?",
                [post_id],
            )
            row = self.cur.fetchone()
            return float(row[0]) if row else None

        return await asyncio.to_thread(_impl)

    async def upsert_waifu_score(self, post_id: int, score: float) -> None:
        def _impl() -> None:
            self.cur.execute(
                "INSERT INTO post_waifu_scores(post_id, score) VALUES (?, ?) "
                "ON CONFLICT (post_id) DO UPDATE SET score = excluded.score",
                [post_id, score],
            )

        await asyncio.to_thread(_impl)

    # ─── Process-failure blacklist ───────────────────────────────────
    async def record_failures(
        self,
        rows: list[tuple[int, str, str]],
    ) -> None:
        """Mark (post_id, worker) pairs as permanently failed.

        ``rows`` are ``(post_id, worker, error_message)`` triples. Uses
        INSERT OR IGNORE so re-recording the same failure (e.g. when the
        old data is reprocessed after a deliberate retry-then-fail-again
        cycle that *didn't* delete the existing row) is a no-op rather
        than an integrity error.
        """
        if not rows:
            return

        def _impl() -> None:
            self.cur.executemany(
                "INSERT OR IGNORE INTO post_process_failures "
                "(post_id, worker, error) VALUES (?, ?, ?)",
                rows,
            )

        await asyncio.to_thread(_impl)


# ─── Helpers ────────────────────────────────────────────────────────────
# Half-open intervals [min, max). 'D' covers [0, 2), 'S' actually [8, 10] —
# the upper edge is enforced by the source domain (scores clamp to [0, 10]).
WAIFU_SCORE_BUCKETS: dict[str, tuple[float, float]] = {
    "D": (0.0, 2.0),
    "C": (2.0, 4.0),
    "B": (4.0, 6.0),
    "A": (6.0, 8.0),
    "S": (8.0, 10.001),
}
WAIFU_SCORE_BUCKET_UNSCORED = "UNSCORED"


def _build_filter_clauses(  # noqa: PLR0913, C901, PLR0912
    *,
    rating: tuple[int, ...] | None = None,
    score: tuple[int, ...] | None = None,
    tags: tuple[str, ...] | None = None,
    extension: tuple[str, ...] | None = None,
    folder: str | None = None,
    waifu_score_range: tuple[float, float] | None = None,
    waifu_score_levels: tuple[str, ...] | None = None,
) -> tuple[list[str], list[Any], list[str]]:
    where: list[str] = []
    params: list[Any] = []
    joins: list[str] = []
    if rating:
        ph = ",".join("?" * len(rating))
        where.append(f"p.rating IN ({ph})")
        params.extend(rating)
    if score:
        ph = ",".join("?" * len(score))
        where.append(f"p.score IN ({ph})")
        params.extend(score)
    if tags:
        ph = ",".join("?" * len(tags))
        where.append(
            f"EXISTS (SELECT 1 FROM post_has_tag pht "  # noqa: S608
            f"WHERE pht.post_id = p.id AND pht.tag_name IN ({ph}))",
        )
        params.extend(tags)
    if extension:
        ph = ",".join("?" * len(extension))
        where.append(f"p.extension IN ({ph})")
        params.extend(extension)
    if folder and folder != ".":
        # GLOB is case-sensitive and uses default index, unlike LIKE in SQLite.
        where.append("p.file_path GLOB ?")
        params.append(f"{folder}*")

    needs_waifu_join = bool(waifu_score_range) or bool(waifu_score_levels)
    if needs_waifu_join:
        joins.append("LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id")

    if waifu_score_range:
        where.append("pws.score >= ? AND pws.score <= ?")
        params.extend([waifu_score_range[0], waifu_score_range[1]])

    if waifu_score_levels:
        clauses: list[str] = []
        include_unscored = False
        for lvl in waifu_score_levels:
            if lvl == WAIFU_SCORE_BUCKET_UNSCORED:
                include_unscored = True
                continue
            if lvl not in WAIFU_SCORE_BUCKETS:
                continue
            lo, hi = WAIFU_SCORE_BUCKETS[lvl]
            clauses.append("(pws.score >= ? AND pws.score < ?)")
            params.extend([lo, hi])
        if include_unscored:
            clauses.append("pws.post_id IS NULL")
        if clauses:
            where.append("(" + " OR ".join(clauses) + ")")

    return where, params, joins
