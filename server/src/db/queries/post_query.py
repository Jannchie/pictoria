"""PostQueryService — the read/query side of the posts domain.

This owns everything that turns a ``PostFilter`` (or a post id) into a
read model: detail/list/search assembly and filtered counts/aggregates. It
composes the focused row repositories (``TagRepo`` / ``ColorRepo`` /
``ScoreRepo``) for the per-table batch fetches and does the ``posts``-table
base SELECTs itself, so the three previously-duplicated assembly sites
(``get_detail`` single, ``list_paginated`` batch, ``search`` colors-only) now
share one set of helpers.

The returned dicts are shaped for ``PostDetailPublic`` / ``PostSimplePublic`` /
``PostStatsResponse`` ``.model_validate``; the controller layer no longer
hand-builds them.
"""

from __future__ import annotations

import asyncio
import struct
from typing import TYPE_CHECKING, Any

import sqlite_vec

from db.entities import POST_COLUMNS
from db.filters import (
    GROUPABLE_COLUMNS,
    ORDERABLE_COLUMNS,
    SILVA_SCORE_BUCKETS,
    WAIFU_SCORE_BUCKETS,
    PostFilter,
    PostFilterWithOrder,
    bucket_case_sql,
    build_where,
)
from db.helpers import fetch_all_dicts, fetch_one_dict
from db.repositories.colors import ColorRepo
from db.repositories.scores import ScoreRepo
from db.repositories.tags import TagRepo

if TYPE_CHECKING:
    import sqlite3

    import numpy as np


SIMPLE_POST_COLUMNS = (
    "id, file_path, file_name, extension, rating, score, size, width, height, "
    "aspect_ratio, dominant_color, arthash, sha256"
)


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


class PostQueryService:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur
        # Composed focused repos share this cursor; every read runs inside a
        # single ``asyncio.to_thread`` block so the calls are serialised.
        self._tags = TagRepo(cur)
        self._colors = ColorRepo(cur)
        self._scores = ScoreRepo(cur)

    # ─── Read single ──────────────────────────────────────────────────
    async def get_detail(self, post_id: int) -> dict | None:
        """Detail read model: post columns + joined tags / colors / scores.

        Returns ``None`` if the post doesn't exist.
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
            ids = [post_id]
            tags = self._tags.fetch_tags_by_ids(ids).get(post_id, [])
            colors = self._colors.fetch_by_ids(ids).get(post_id, [])
            waifu_score = self._scores.fetch_waifu_by_ids(ids).get(post_id)
            aesthetic_scores = self._scores.fetch_aesthetic_by_ids(ids).get(post_id, [])
            return {
                **post,
                "tags": tags,
                "colors": colors,
                "waifu_score": waifu_score,
                "aesthetic_scores": aesthetic_scores,
            }

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
            colors = self._colors.fetch_by_ids([post_id]).get(post_id, [])
            return {**post, "colors": colors}

        return await asyncio.to_thread(_impl)

    # ─── Read many ────────────────────────────────────────────────────
    async def list_paginated(self, start: int, limit: int) -> tuple[list[dict], int | None]:
        """Return ``(items_as_detail_dicts, next_cursor)``.

        Batches the joined lookups (tags, colors, waifu, aesthetic scores) into
        a single SQL round-trip each, then stitches them in Python.
        """

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

            ids = [p["id"] for p in posts]
            tags_by_post = self._tags.fetch_tags_by_ids(ids)
            colors_by_post = self._colors.fetch_by_ids(ids)
            waifu_by_post = self._scores.fetch_waifu_by_ids(ids)
            aesthetic_by_post = self._scores.fetch_aesthetic_by_ids(ids)

            details = [
                {
                    **p,
                    "tags": tags_by_post.get(p["id"], []),
                    "colors": colors_by_post.get(p["id"], []),
                    "waifu_score": waifu_by_post.get(p["id"]),
                    "aesthetic_scores": aesthetic_by_post.get(p["id"], []),
                }
                for p in posts
            ]
            return details, next_cursor

        return await asyncio.to_thread(_impl)

    async def list_simple_by_ids_preserving_order(self, id_list: list[int]) -> list[dict]:
        """Return PostSimplePublic-shape rows in the same order as ``id_list``."""

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
            colors_by_post = self._colors.fetch_by_ids(ids)
            for r in ordered:
                r["colors"] = colors_by_post.get(r["id"], [])
            return ordered

        return await asyncio.to_thread(_impl)

    async def search(self, f: PostFilterWithOrder, *, limit: int = 100, offset: int = 0) -> list[dict]:  # noqa: C901
        """Search posts, returning rows ready for ``PostSimplePublic``.

        ``f.lab`` triggers brute-force L2 distance ordering over dominant_color
        via sqlite-vec's ``vec_distance_L2``. ``f.order_by`` is one of the
        whitelisted columns; ``f.order`` is ``asc`` | ``desc`` | ``random``.
        """

        def _impl() -> list[dict]:
            where_clauses, params, joins = build_where(f)

            select_cols = (
                "SELECT p.id, p.file_path, p.file_name, p.extension, p.rating, "
                "p.score, p.size, p.width, p.height, p.aspect_ratio, p.dominant_color, "
                "p.arthash, p.sha256"
            )
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

            if f.lab is not None:
                from_clause = "FROM posts p" + ("\n" + "\n".join(joins) if joins else "")
                lab_blob = sqlite_vec.serialize_float32(list(f.lab))
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
                # Score-based ordering joins the scorer table on demand and uses
                # ``NULLS LAST`` so unscored posts sink to the bottom.
                extra_joins: list[str] = []
                order_sql = ""
                order_params: list[Any] = []
                if f.order == "random":
                    # SQLite's random() re-rolls every row on every execution, so
                    # offset pagination over `ORDER BY random()` reshuffles each
                    # page (duplicates + gaps — the list never converges). Instead
                    # order by a multiplicative hash of (id, seed) mod a Mersenne
                    # prime: for a seed coprime to the prime this is a stable
                    # permutation of the ids — same seed → identical order across
                    # pages, a fresh seed → a new shuffle.
                    seed = (f.order_seed or 1) % 2147483647 or 1
                    order_sql = "ORDER BY ((p.id * ?) % 2147483647)"
                    order_params.append(seed)
                elif f.order_by and f.order_by in ORDERABLE_COLUMNS:
                    direction = "ASC" if f.order == "asc" else "DESC"
                    # Unique tie-breaker so offset pagination is stable: rows tied
                    # on the sort column (many share score/rating, NULLs galore)
                    # otherwise order arbitrarily and differ between page fetches.
                    tiebreak = "" if f.order_by == "id" else f", p.id {direction}"
                    if f.order_by == "waifu_score":
                        if not any("post_waifu_scores" in j for j in joins):
                            extra_joins.append(
                                "LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id",
                            )
                        order_sql = f"ORDER BY pws.score {direction} NULLS LAST{tiebreak}"
                    elif f.order_by == "silva_score":
                        # build_where may already have joined pas_silva for a
                        # silva_score_levels filter; don't double-join the alias.
                        if not any("pas_silva" in j for j in joins):
                            extra_joins.append(
                                "LEFT JOIN post_aesthetic_scores pas_silva "
                                "ON pas_silva.post_id = p.id AND pas_silva.scorer = 'silva'",
                            )
                        order_sql = f"ORDER BY pas_silva.score {direction} NULLS LAST{tiebreak}"
                    else:
                        order_sql = f"ORDER BY p.{f.order_by} {direction}{tiebreak}"

                all_joins = joins + extra_joins
                from_clause = "FROM posts p" + ("\n" + "\n".join(all_joins) if all_joins else "")
                sql = (
                    f"{select_cols} {from_clause} {where_sql} {order_sql} LIMIT ? OFFSET ?"
                )
                self.cur.execute(sql, [*params, *order_params, limit, offset])

            rows = fetch_all_dicts(self.cur)
            for r in rows:
                r.pop("_dist", None)
            _decode_dominant_colors_in(rows)
            ids = [r["id"] for r in rows]
            colors_by_post = self._colors.fetch_by_ids(ids)
            for r in rows:
                r["colors"] = colors_by_post.get(r["id"], [])
            return rows

        return await asyncio.to_thread(_impl)

    async def search_by_text_vector(
        self,
        vec: np.ndarray | list[float],
        f: PostFilter,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """Rank posts by SigLIP 2 cosine similarity to ``vec``, within filter ``f``.

        Runs vec0's native ``MATCH ... k=N`` KNN as a single fast subquery, then
        JOINs ``posts`` and applies ``build_where(f)`` as a post-filter, ordering
        by the KNN distance.

        We deliberately do NOT brute-force ``vec_distance_cosine`` over the whole
        table: on a ~170k-row library that full scan + TEMP-B-TREE sort runs for
        minutes and stalls every other request (vec0 falls back to ``INDEX 0:1``
        full-scan), whereas the native KNN (``INDEX 0:3``) returns in ~1-2s. When
        a filter is present we oversample KNN candidates so the post-filter can
        still fill ``limit`` for typical filters; a very narrow filter may yield
        fewer than ``limit`` rows. Posts without a SigLIP 2 embedding never
        appear (they aren't in the KNN table).
        """

        def _impl() -> list[dict]:
            where_clauses, params, joins = build_where(f)
            vec_blob = sqlite_vec.serialize_float32(list(vec))
            want = limit + offset
            # vec0's KNN cost is dominated by the O(N) distance scan, so a larger
            # k is nearly free; oversample when filtering so the post-filter has
            # enough candidates to fill `limit`.
            k = want if not where_clauses else max(want, 1000)
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            sql = f"""
                SELECT p.id, p.file_path, p.file_name, p.extension, p.rating,
                       p.score, p.size, p.width, p.height, p.aspect_ratio,
                       p.dominant_color, p.arthash, p.sha256,
                       knn.distance AS _knn_distance
                FROM (SELECT post_id, distance FROM post_vectors_siglip2
                      WHERE embedding MATCH ? AND k = ?) AS knn
                JOIN posts p ON p.id = knn.post_id
                {joins_sql}
                {where_sql}
                ORDER BY knn.distance LIMIT ? OFFSET ?
            """  # noqa: S608
            self.cur.execute(sql, [vec_blob, k, *params, limit, offset])
            rows = fetch_all_dicts(self.cur)
            _decode_dominant_colors_in(rows)
            ids = [r["id"] for r in rows]
            colors_by_post = self._colors.fetch_by_ids(ids)
            for r in rows:
                r["colors"] = colors_by_post.get(r["id"], [])
            return rows

        return await asyncio.to_thread(_impl)

    # ─── Counts / aggregates ──────────────────────────────────────────
    async def count(self, f: PostFilter) -> int:
        def _impl() -> int:
            where_clauses, params, joins = build_where(f)
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"SELECT count(p.id) FROM posts p {joins_sql} {where_sql}",  # noqa: S608
                params,
            )
            row = self.cur.fetchone()
            return int(row[0]) if row else 0

        return await asyncio.to_thread(_impl)

    async def count_by_column(self, column: str, f: PostFilter) -> list[dict]:
        if column not in GROUPABLE_COLUMNS:
            msg = f"Cannot group by unsafe column: {column}"
            raise ValueError(msg)

        def _impl() -> list[dict]:
            where_clauses, params, joins = build_where(f)
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"SELECT p.{column} AS {column}, count(*) AS count "  # noqa: S608
                f"FROM posts p {joins_sql} {where_sql} GROUP BY p.{column}",
                params,
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def count_by_waifu_bucket(self, f: PostFilter) -> list[dict]:
        """Group posts into the 5 waifu-score buckets (A/B/C/D/E) plus UNSCORED."""

        def _impl() -> list[dict]:
            where_clauses, params, joins = build_where(f)
            if not any("post_waifu_scores" in j for j in joins):
                joins.append("LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id")
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"""
                SELECT
                    {bucket_case_sql(WAIFU_SCORE_BUCKETS, "pws.score", "pws.post_id")} AS bucket,
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

    async def count_by_silva_bucket(self, f: PostFilter) -> list[dict]:
        """Group posts into the 5 SILVA buckets (A/B/C/D/E) plus UNSCORED."""

        def _impl() -> list[dict]:
            where_clauses, params, joins = build_where(f)
            if not any("pas_silva" in j for j in joins):
                joins.append(
                    "LEFT JOIN post_aesthetic_scores pas_silva "
                    "ON pas_silva.post_id = p.id AND pas_silva.scorer = 'silva'",
                )
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"""
                SELECT
                    {bucket_case_sql(SILVA_SCORE_BUCKETS, "pas_silva.score", "pas_silva.post_id")} AS bucket,
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

    async def aggregate_stats(self, f: PostFilter) -> dict:
        """Aggregate post-quality stats for a filter (used by the footer)."""

        def _impl() -> dict:
            where_clauses, params, joins = build_where(f)
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
