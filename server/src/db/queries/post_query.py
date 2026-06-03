"""PostQueryService 窶・the read/query side of the posts domain.

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
from dataclasses import dataclass
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
    has_active_filters,
)
from db.helpers import decode_dominant_color, fetch_all_dicts, fetch_one_dict, sql_placeholders
from db.repositories.colors import ColorRepo
from db.repositories.scores import ScoreRepo
from db.repositories.tags import TagRepo

if TYPE_CHECKING:
    import sqlite3

    import numpy as np


SIMPLE_POST_COLUMNS = (
    "id, file_path, file_name, extension, rating, score, size, width, height, "
    "aspect_ratio, dominant_color, arthash, sha256, canonical_post_id"
)


def _decode_dominant_colors_in(rows: list[dict]) -> None:
    """Decode the ``dominant_color`` field on a batch of result dicts in place."""
    for r in rows:
        if "dominant_color" in r:
            r["dominant_color"] = decode_dominant_color(r["dominant_color"])


@dataclass
class FolderScoreAgg:
    """Score/rating sums over the posts whose ``file_path`` is one directory.

    Serves two roles: the per-directory direct aggregate returned by
    ``folder_score_aggregates`` and the accumulator the folder-tree roll-up
    adds children into (see ``server.folders.attach_folder_stats``).
    """

    posts: int = 0
    scored: int = 0  # posts with score > 0 (manual star given)
    score_total: float = 0.0  # sum of score over scored posts only
    rating_total: float = 0.0  # sum of rating over all posts
    silva_total: float = 0.0  # sum of raw silva score (0~1)
    silva_n: int = 0  # posts that have a silva score

    def add(self, other: FolderScoreAgg) -> None:
        self.posts += other.posts
        self.scored += other.scored
        self.score_total += other.score_total
        self.rating_total += other.rating_total
        self.silva_total += other.silva_total
        self.silva_n += other.silva_n


class PostQueryService:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur
        # Composed focused repos share this cursor; every read runs inside a
        # single ``asyncio.to_thread`` block so the calls are serialised.
        self._tags = TagRepo(cur)
        self._colors = ColorRepo(cur)
        self._scores = ScoreRepo(cur)

    # ─── Near-duplicate group helpers ─────────────────────────────────
    def _member_counts(self, canonical_ids: list[int]) -> dict[int, int]:
        """How many hidden members each canonical post has: ``{canonical_id: n}``.

        Sync helper — called inside the ``asyncio.to_thread`` blocks below so the
        member-count lookup shares the read's single round-trip budget. Only
        canonical posts (those whose id appears as another post's
        ``canonical_post_id``) get an entry; non-grouped posts are absent (0).
        """
        if not canonical_ids:
            return {}
        placeholders = sql_placeholders(canonical_ids)
        self.cur.execute(
            f"SELECT canonical_post_id, count(*) FROM posts "  # noqa: S608
            f"WHERE canonical_post_id IN ({placeholders}) GROUP BY canonical_post_id",
            canonical_ids,
        )
        return {row[0]: row[1] for row in self.cur.fetchall()}

    def _attach_member_counts(self, rows: list[dict]) -> None:
        """Attach ``group_member_count`` to each row dict in place."""
        counts = self._member_counts([r["id"] for r in rows])
        for r in rows:
            r["group_member_count"] = counts.get(r["id"], 0)

    async def get_group_members(self, canonical_id: int) -> list[dict]:
        """Return the hidden members of ``canonical_id``'s group, oldest first.

        Used by the post-detail "same group" strip to reveal the other
        resolutions / near-duplicates hidden from the main listings. Returns
        ``[]`` when the post has no members.
        """

        def _impl() -> list[dict]:
            self.cur.execute(
                f"SELECT {SIMPLE_POST_COLUMNS} FROM posts "  # noqa: S608
                "WHERE canonical_post_id = ? ORDER BY id ASC",
                [canonical_id],
            )
            rows = fetch_all_dicts(self.cur)
            _decode_dominant_colors_in(rows)
            ids = [r["id"] for r in rows]
            colors_by_post = self._colors.fetch_by_ids(ids)
            for r in rows:
                r["colors"] = colors_by_post.get(r["id"], [])
                r["group_member_count"] = 0
            return rows

        return await asyncio.to_thread(_impl)

    # 笏笏笏 Read single 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
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
                "group_member_count": self._member_counts([post_id]).get(post_id, 0),
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

    # 笏笏笏 Read many 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
    async def list_paginated(self, start: int, limit: int) -> tuple[list[dict], int | None]:
        """Return ``(items_as_detail_dicts, next_cursor)``.

        Batches the joined lookups (tags, colors, waifu, aesthetic scores) into
        a single SQL round-trip each, then stitches them in Python.
        """

        def _impl() -> tuple[list[dict], int | None]:
            self.cur.execute(
                f"SELECT {POST_COLUMNS} FROM posts "  # noqa: S608
                "WHERE id >= ? AND canonical_post_id IS NULL ORDER BY id ASC LIMIT ?",
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
            member_counts = self._member_counts(ids)

            details = [
                {
                    **p,
                    "tags": tags_by_post.get(p["id"], []),
                    "colors": colors_by_post.get(p["id"], []),
                    "waifu_score": waifu_by_post.get(p["id"]),
                    "aesthetic_scores": aesthetic_by_post.get(p["id"], []),
                    "group_member_count": member_counts.get(p["id"], 0),
                }
                for p in posts
            ]
            return details, next_cursor

        return await asyncio.to_thread(_impl)

    async def list_simple_by_ids_preserving_order(
        self, id_list: list[int], *, only_canonical: bool = False,
    ) -> list[dict]:
        """Return PostSimplePublic-shape rows in the same order as ``id_list``.

        ``only_canonical=True`` drops near-duplicate group members from the
        result — used by the similar-image search so hidden members don't leak
        into the grid (only their canonical representative should surface).
        """

        def _impl() -> list[dict]:
            if not id_list:
                return []
            placeholders = sql_placeholders(id_list)
            self.cur.execute(
                f"SELECT {SIMPLE_POST_COLUMNS} FROM posts WHERE id IN ({placeholders})",  # noqa: S608
                id_list,
            )
            rows = fetch_all_dicts(self.cur)
            _decode_dominant_colors_in(rows)
            by_id = {r["id"]: r for r in rows}
            ordered = [by_id[i] for i in id_list if i in by_id]
            if only_canonical:
                ordered = [r for r in ordered if r["canonical_post_id"] is None]
            ids = [r["id"] for r in ordered]
            colors_by_post = self._colors.fetch_by_ids(ids)
            for r in ordered:
                r["colors"] = colors_by_post.get(r["id"], [])
            self._attach_member_counts(ordered)
            return ordered

        return await asyncio.to_thread(_impl)

    async def search(self, f: PostFilterWithOrder, *, limit: int = 100, offset: int = 0) -> list[dict]:  # noqa: C901, PLR0915
        """Search posts, returning rows ready for ``PostSimplePublic``.

        ``f.lab`` triggers brute-force L2 distance ordering over dominant_color
        via sqlite-vec's ``vec_distance_L2``. ``f.order_by`` is one of the
        whitelisted columns; ``f.order`` is ``asc`` | ``desc`` | ``random``.
        """

        def _impl() -> list[dict]:  # noqa: C901, PLR0912, PLR0915
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
                resort_sql = ""
                if f.order == "random":
                    seed = (f.order_seed or 1) % 2147483647 or 1
                    order_sql = "ORDER BY ((p.id * ?) % 2147483647)"
                    order_params.append(seed)
                    if f.order_by and f.order_by in ORDERABLE_COLUMNS:
                        if f.order_by == "waifu_score":
                            if not any("post_waifu_scores" in j for j in joins):
                                extra_joins.append(
                                    "LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id",
                                )
                            select_cols += ", pws.score AS _sort_col"
                        elif f.order_by == "silva_score":
                            if not any("pas_silva" in j for j in joins):
                                extra_joins.append(
                                    "LEFT JOIN post_aesthetic_scores pas_silva "
                                    "ON pas_silva.post_id = p.id AND pas_silva.scorer = 'silva'",
                                )
                            select_cols += ", pas_silva.score AS _sort_col"
                        else:
                            select_cols += f", p.{f.order_by} AS _sort_col"
                        resort_dir = "ASC" if f.sort_direction == "asc" else "DESC"
                        resort_sql = f"ORDER BY _sort_col {resort_dir} NULLS LAST"
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
                if resort_sql:
                    inner_sql = f"{select_cols} {from_clause} {where_sql} {order_sql} LIMIT ? OFFSET ?"
                    sql = f"SELECT * FROM ({inner_sql}) {resort_sql}"  # noqa: S608
                else:
                    sql = f"{select_cols} {from_clause} {where_sql} {order_sql} LIMIT ? OFFSET ?"
                self.cur.execute(sql, [*params, *order_params, limit, offset])

            rows = fetch_all_dicts(self.cur)
            for r in rows:
                r.pop("_dist", None)
                r.pop("_sort_col", None)
            _decode_dominant_colors_in(rows)
            ids = [r["id"] for r in rows]
            colors_by_post = self._colors.fetch_by_ids(ids)
            for r in rows:
                r["colors"] = colors_by_post.get(r["id"], [])
            self._attach_member_counts(rows)
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
            self._attach_member_counts(rows)
            return rows

        return await asyncio.to_thread(_impl)

    # 笏笏笏 Counts / aggregates 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
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

    async def folder_score_aggregates(self) -> dict[str, FolderScoreAgg]:
        """Sum score / rating / silva per ``file_path`` directory in one GROUP BY.

        Keyed by ``posts.file_path`` (the directory a post lives in, e.g.
        ``'danbooru/wlop'``; root posts use ``'.'``). The folder controller
        rolls these per-directory sums up the tree. ``score_total`` / ``scored``
        cover only scored posts (``score > 0``) so unscored 0s don't drag the
        manual-score average down; coverage is reported separately via the ratio.
        """

        def _impl() -> dict[str, FolderScoreAgg]:
            self.cur.execute(
                """
                SELECT
                    p.file_path                                          AS file_path,
                    count(*)                                             AS posts,
                    sum(CASE WHEN p.score > 0 THEN 1 ELSE 0 END)         AS scored,
                    sum(CASE WHEN p.score > 0 THEN p.score ELSE 0 END)   AS score_total,
                    sum(p.rating)                                        AS rating_total,
                    sum(COALESCE(a.score, 0))                            AS silva_total,
                    sum(CASE WHEN a.score IS NOT NULL THEN 1 ELSE 0 END) AS silva_n
                FROM posts p
                LEFT JOIN post_aesthetic_scores a
                       ON a.post_id = p.id AND a.scorer = 'silva'
                GROUP BY p.file_path
                """,
            )
            return {
                row[0]: FolderScoreAgg(
                    posts=int(row[1]),
                    scored=int(row[2]),
                    score_total=float(row[3]),
                    rating_total=float(row[4]),
                    silva_total=float(row[5]),
                    silva_n=int(row[6]),
                )
                for row in self.cur.fetchall()
            }

        return await asyncio.to_thread(_impl)

    async def count_by_tag(self, f: PostFilter, query: str = "", limit: int = 50) -> list[dict]:
        """Count how many filtered posts carry each tag — the tag-filter facet.

        Tags are many-to-many, so (unlike ``count_by_column``) we JOIN
        ``post_has_tag`` and GROUP BY ``tag_name``. The client clears the ``tags``
        facet before counting (see ``filterWithoutSelf``), so this answers "if I
        add tag X, how many posts match". ``query`` substring-filters tag names so
        the searchable dropdown can surface rare tags outside the top-N; ``limit``
        caps the rows, ordered by descending count then name.
        """

        def _impl() -> list[dict]:
            where_clauses, params, joins = build_where(f)
            escaped_like: str | None = None
            if query:
                # Escape LIKE metacharacters so '%' / '_' typed in the search box
                # match literally (the default ESCAPE char '\' is escaped first).
                escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                escaped_like = f"%{escaped}%"

            # Fast path: no *content* filter, so each tag's match count is just
            # its canonical-post total, maintained on tags.post_count by trigger
            # (the triggers count only canonical posts, so this already excludes
            # hidden group members). Served from ix_tags_post_count instead of
            # GROUP BY-ing the ~9.4M-row post_has_tag table on every dropdown
            # open. ``only_canonical`` alone keeps us on this path; the live path
            # is taken only when a real filter narrows the set (or members are
            # explicitly requested via only_canonical=False).
            if f.only_canonical and not has_active_filters(f):
                fast_params: list[Any] = []
                sql = "SELECT name AS tag_name, post_count AS count FROM tags WHERE post_count > 0"
                if escaped_like is not None:
                    sql += " AND name LIKE ? ESCAPE '\\'"
                    fast_params.append(escaped_like)
                sql += " ORDER BY post_count DESC, name ASC LIMIT ?"
                fast_params.append(limit)
                self.cur.execute(sql, fast_params)
                return fetch_all_dicts(self.cur)

            # Filtered path: live GROUP BY over the join. The filter narrows the
            # post set first, so this scans far fewer than the full association table.
            if escaped_like is not None:
                where_clauses.append("pt.tag_name LIKE ? ESCAPE '\\'")
                params.append(escaped_like)
            params.append(limit)  # bound LAST — matches the trailing ? in LIMIT
            joins_sql = "\n".join(joins)
            where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"SELECT pt.tag_name AS tag_name, count(*) AS count "  # noqa: S608
                f"FROM posts p JOIN post_has_tag pt ON pt.post_id = p.id "
                f"{joins_sql} {where_sql} "
                f"GROUP BY pt.tag_name "
                f"ORDER BY count DESC, pt.tag_name ASC "
                f"LIMIT ?",
                params,
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def _count_by_scorer_bucket(  # noqa: PLR0913
        self,
        f: PostFilter,
        buckets: dict[str, tuple[float, float]],
        score_col: str,
        null_col: str,
        join_sql: str,
        join_marker: str,
    ) -> list[dict]:
        def _impl() -> list[dict]:
            where_clauses, params, joins = build_where(f)
            if not any(join_marker in j for j in joins):
                joins.append(join_sql)
            joins_str = "\n".join(joins)
            where_str = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            self.cur.execute(
                f"""
                SELECT
                    {bucket_case_sql(buckets, score_col, null_col)} AS bucket,
                    count(*) AS count
                FROM posts p
                {joins_str}
                {where_str}
                GROUP BY bucket
                """,  # noqa: S608
                params,
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def count_by_waifu_bucket(self, f: PostFilter) -> list[dict]:
        """Group posts into the 5 waifu-score buckets (A/B/C/D/E) plus UNSCORED."""
        return await self._count_by_scorer_bucket(
            f, WAIFU_SCORE_BUCKETS, "pws.score", "pws.post_id",
            "LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id",
            "post_waifu_scores",
        )

    async def count_by_silva_bucket(self, f: PostFilter) -> list[dict]:
        """Group posts into the 5 SILVA buckets (A/B/C/D/E) plus UNSCORED."""
        return await self._count_by_scorer_bucket(
            f, SILVA_SCORE_BUCKETS, "pas_silva.score", "pas_silva.post_id",
            "LEFT JOIN post_aesthetic_scores pas_silva "
            "ON pas_silva.post_id = p.id AND pas_silva.scorer = 'silva'",
            "pas_silva",
        )

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
