"""Query-side value objects and SQL-fragment builders for the ``posts`` table.

``PostFilter`` is the single source of truth for *which* posts a read touches —
consumed by the read/query layer (listing, search, counts, aggregates). It
deliberately lives in the db layer rather than ``scheme.py`` so the data-access
code does not depend on the API DTO module; Litestar still binds request bodies
to these ``msgspec.Struct`` types directly because msgspec Structs are
first-class request types.

This module also centralizes the column allowlists that used to be duplicated
as inline string sets across ``PostRepo`` (orderable columns, updatable fields,
groupable columns) so a column rename only has to touch one place.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from msgspec import Meta, Struct


class PostFilter(Struct):
    rating: Annotated[tuple[int, ...] | None, Meta(description="Rating filter.", examples=[(1, 2, 3)])] = ()
    score: Annotated[tuple[int, ...] | None, Meta(description="Score filter.", examples=[(1, 2, 3)])] = ()
    tags: Annotated[tuple[str, ...] | None, Meta(description="Tag filter.", examples=[("tag1", "tag2")])] = ()
    extension: Annotated[tuple[str, ...] | None, Meta(description="Extension filter.", examples=[("jpg", "png")])] = ()
    folder: str | None = None
    lab: Annotated[
        tuple[float, float, float] | None,
        Meta(description="LAB color filter.", examples=[(0.5, 0.5, 0.5)],
             extra_json_schema={"min_length": 3, "max_length": 3}),
    ] = None
    waifu_score_range: Annotated[
        tuple[float, float] | None,
        Meta(description="Waifu score range filter.", examples=[(0.0, 10.0)],
             extra_json_schema={"min_length": 2, "max_length": 2}),
    ] = None
    waifu_score_levels: Annotated[
        tuple[str, ...] | None,
        Meta(
            description=(
                "Waifu-score bucket filter. Each value is one of "
                "'A' (8-10), 'B' (6-8), 'C' (4-6), 'D' (2-4), 'E' (0-2), "
                "or 'UNSCORED' (no waifu score yet). Multiple values OR together."
            ),
            examples=[("A", "B")],
        ),
    ] = ()
    silva_score_levels: Annotated[
        tuple[str, ...] | None,
        Meta(
            description=(
                "SILVA aesthetic bucket filter. Each value is one of "
                "'A' (0.8-1.0), 'B' (0.6-0.8), 'C' (0.4-0.6), 'D' (0.2-0.4), "
                "'E' (0-0.2), or 'UNSCORED' (no SILVA score yet). OR together."
            ),
            examples=[("A", "B")],
        ),
    ] = ()


class PostFilterWithOrder(PostFilter):
    order_by: Annotated[
        Literal[
            "id", "score", "rating", "created_at", "published_at", "file_name",
            "last_accessed_at", "waifu_score", "silva_score",
        ] | None,
        Meta(description="Order column.", examples=["id"],
             extra_json_schema={"enum": [
                 "id", "score", "rating", "created_at", "published_at", "file_name",
                 "last_accessed_at", "waifu_score", "silva_score",
             ]}),
    ] = None
    order: Annotated[
        Literal["asc", "desc", "random"],
        Meta(description="Order direction.", examples=["desc", "asc", "random"],
             extra_json_schema={"enum": ["asc", "desc", "random"]}),
    ] = "desc"
    order_seed: Annotated[
        int | None,
        Meta(
            description=(
                "Seed for ``order='random'``. The same seed yields a stable shuffle, "
                "so offset pagination stays consistent across pages; a fresh seed "
                "reshuffles. Ignored unless ``order='random'``."
            ),
            examples=[42],
        ),
    ] = None


# ─── Column allowlists (centralized; previously scattered across PostRepo) ───
# Columns the search layer may ORDER BY. ``waifu_score`` / ``silva_score`` are
# virtual: they resolve to joined-table columns, handled by the query layer.
ORDERABLE_COLUMNS: frozenset[str] = frozenset({
    "id", "score", "rating", "created_at", "published_at", "file_name",
    "last_accessed_at", "waifu_score", "silva_score",
})
# Scalar columns a single-field update may target.
UPDATABLE_FIELDS: frozenset[str] = frozenset({
    "score", "rating", "caption", "source", "description", "meta",
})
# Columns a bulk update may target.
BULK_UPDATABLE_FIELDS: frozenset[str] = frozenset({"score", "rating"})
# Columns ``count_by_column`` may GROUP BY.
GROUPABLE_COLUMNS: frozenset[str] = frozenset({"rating", "score", "extension"})


# ─── Waifu-score buckets ────────────────────────────────────────────────────
# Half-open intervals [min, max). 'E' covers [0, 2), 'A' actually [8, 10] —
# the upper edge is enforced by the source domain (scores clamp to [0, 10]).
WAIFU_SCORE_BUCKETS: dict[str, tuple[float, float]] = {
    "E": (0.0, 2.0),
    "D": (2.0, 4.0),
    "C": (4.0, 6.0),
    "B": (6.0, 8.0),
    "A": (8.0, 10.001),
}
# SILVA aesthetic scores are [0, 1]; same five A-E grades on a /10 scale.
SILVA_SCORE_BUCKETS: dict[str, tuple[float, float]] = {
    "E": (0.0, 0.2),
    "D": (0.2, 0.4),
    "C": (0.4, 0.6),
    "B": (0.6, 0.8),
    "A": (0.8, 1.0001),
}
SCORE_BUCKET_UNSCORED = "UNSCORED"


def bucket_case_sql(
    buckets: dict[str, tuple[float, float]],
    score_col: str,
    null_col: str,
) -> str:
    """Build the ``CASE`` that labels a row's score bucket from ``buckets``.

    Shared by the waifu and SILVA bucket *filters* (``build_where``) and
    *aggregations* (``count_by_*_bucket``), so each scorer's A-E edges live in
    exactly one constant. Labels and bounds come from the trusted ``buckets``
    mapping only - no caller input reaches this string.
    """
    # Highest lower-bound first; the lowest bucket falls through to ELSE.
    ordered = sorted(buckets.items(), key=lambda kv: kv[1][0], reverse=True)
    *above, (lowest_label, _) = ordered
    whens = "\n".join(f"WHEN {score_col} >= {lo} THEN '{label}'" for label, (lo, _hi) in above)
    return (
        "CASE\n"
        f"WHEN {null_col} IS NULL THEN '{SCORE_BUCKET_UNSCORED}'\n"
        f"{whens}\n"
        f"ELSE '{lowest_label}'\n"
        "END"
    )


def build_where(f: PostFilter) -> tuple[list[str], list[Any], list[str]]:  # noqa: C901, PLR0912, PLR0915
    """Translate a ``PostFilter`` into ``(where_clauses, params, joins)``.

    ``lab`` is intentionally not handled here: distance ordering needs a
    SELECT-list expression and a special ORDER BY, so the search method owns it.
    """
    where: list[str] = []
    params: list[Any] = []
    joins: list[str] = []
    if f.rating:
        ph = ",".join("?" * len(f.rating))
        where.append(f"p.rating IN ({ph})")
        params.extend(f.rating)
    if f.score:
        ph = ",".join("?" * len(f.score))
        where.append(f"p.score IN ({ph})")
        params.extend(f.score)
    if f.tags:
        ph = ",".join("?" * len(f.tags))
        where.append(
            f"EXISTS (SELECT 1 FROM post_has_tag pht "  # noqa: S608
            f"WHERE pht.post_id = p.id AND pht.tag_name IN ({ph}))",
        )
        params.extend(f.tags)
    if f.extension:
        ph = ",".join("?" * len(f.extension))
        where.append(f"p.extension IN ({ph})")
        params.extend(f.extension)
    if f.folder and f.folder != ".":
        # GLOB is case-sensitive and uses the default index, unlike LIKE in SQLite.
        where.append("p.file_path GLOB ?")
        params.append(f"{f.folder}*")

    needs_waifu_join = bool(f.waifu_score_range) or bool(f.waifu_score_levels)
    if needs_waifu_join:
        joins.append("LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id")

    if f.waifu_score_range:
        where.append("pws.score >= ? AND pws.score <= ?")
        params.extend([f.waifu_score_range[0], f.waifu_score_range[1]])

    if f.waifu_score_levels:
        clauses: list[str] = []
        include_unscored = False
        for lvl in f.waifu_score_levels:
            if lvl == SCORE_BUCKET_UNSCORED:
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

    if f.silva_score_levels:
        # vec0-free: aesthetic scores live in post_aesthetic_scores (scorer
        # 'silva'). Same alias as the order-by join so they dedupe in search().
        joins.append(
            "LEFT JOIN post_aesthetic_scores pas_silva "
            "ON pas_silva.post_id = p.id AND pas_silva.scorer = 'silva'",
        )
        silva_clauses: list[str] = []
        silva_unscored = False
        for lvl in f.silva_score_levels:
            if lvl == SCORE_BUCKET_UNSCORED:
                silva_unscored = True
                continue
            if lvl not in SILVA_SCORE_BUCKETS:
                continue
            lo, hi = SILVA_SCORE_BUCKETS[lvl]
            silva_clauses.append("(pas_silva.score >= ? AND pas_silva.score < ?)")
            params.extend([lo, hi])
        if silva_unscored:
            silva_clauses.append("pas_silva.post_id IS NULL")
        if silva_clauses:
            where.append("(" + " OR ".join(silva_clauses) + ")")

    return where, params, joins
