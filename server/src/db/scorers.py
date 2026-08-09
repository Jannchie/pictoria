"""Scorer registry — the aesthetic-scorer seam.

``post_aesthetic_scores`` is a generic per-(post, scorer) table; each scorer
living in it is described *once* by a :class:`ScorerSpec` — its DB ``scorer``
name, the SQL alias its join uses, the A-E bucket edges over its native score
domain, and the affine map that lifts that native score onto the manual 1-5
scale. Every place that joins the table, buckets a score, or reads the
model-vs-manual discrepancy derives its SQL from a spec, so adding a scorer is
one registry entry instead of a dozen hand-copied ``LEFT JOIN`` / ``CASE``
fragments.

Note: ``post_waifu_scores`` is a *separate legacy single-scorer table* with its
own join shape and 0-10 native scale; it is deliberately NOT in this registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

AESTHETIC_SCORES_TABLE = "post_aesthetic_scores"


@dataclass(frozen=True)
class ScorerSpec:
    """One aesthetic scorer stored in ``post_aesthetic_scores``.

    ``buckets`` are the A-E half-open ``[lo, hi)`` grade edges over the scorer's
    native score domain. ``scale`` / ``offset`` are the affine map onto the
    manual 1-5 scale (``native * scale + offset``) that the ``discrepancy`` sort
    uses to compare the model score against the human star rating.
    """

    name: str
    buckets: dict[str, tuple[float, float]]
    scale: float = 4.0
    offset: float = 1.0

    @property
    def alias(self) -> str:
        """SQL table alias for this scorer's join (e.g. ``pas_silva``)."""
        return f"pas_{self.name}"

    def join_sql(self, *, alias: str | None = None, table_alias: str = "p") -> str:
        """``LEFT JOIN`` fragment binding this scorer's rows to ``table_alias``.

        ``alias`` overrides the derived :attr:`alias` for the few call sites that
        historically used a different one (``folder_score_aggregates`` uses
        ``a``). ``scorer`` is a trusted constant, never caller input.
        """
        a = alias or self.alias
        return f"LEFT JOIN {AESTHETIC_SCORES_TABLE} {a} ON {a}.post_id = {table_alias}.id AND {a}.scorer = '{self.name}'"

    def is_joined(self, joins: Iterable[str]) -> bool:
        """True if ``joins`` already carries this scorer's join.

        Matches the alias as a *whole token* (space-delimited). A bare
        substring test would be wrong the moment two scorer names share a
        prefix: ``pas_silva`` occurs inside ``pas_silva_luna``, so a filter on
        one scorer would be mistaken for a join on the other and the real join
        would be dropped — leaving the SQL referencing an unbound alias.
        """
        token = f" {self.alias} "
        return any(token in j for j in joins)

    def score_col(self, alias: str | None = None) -> str:
        """The score column reference (``pas_silva.score``)."""
        return f"{alias or self.alias}.score"

    def null_col(self, alias: str | None = None) -> str:
        """The column whose NULL marks an unscored post (``pas_silva.post_id``)."""
        return f"{alias or self.alias}.post_id"

    def score_expr(self, alias: str | None = None) -> str:
        """Native score lifted onto the manual 1-5 scale (``score * 4.0 + 1.0``)."""
        return f"{self.score_col(alias)} * {self.scale} + {self.offset}"


# ─── SILVA aesthetic scorer ──────────────────────────────────────────────────
# SILVA native scores are [0, 1]; the same five A-E grades used elsewhere, on a
# ×10 display scale. Half-open intervals [min, max); 'A' actually [0.8, 1.0] —
# the upper edge is enforced by the source domain (scores clamp to [0, 1]).
SILVA_SCORE_BUCKETS: dict[str, tuple[float, float]] = {
    "E": (0.0, 0.2),
    "D": (0.2, 0.4),
    "C": (0.4, 0.6),
    "B": (0.6, 0.8),
    "A": (0.8, 1.0001),
}

SILVA = ScorerSpec(name="silva", buckets=SILVA_SCORE_BUCKETS)

# ─── SILVA-Luna aesthetic scorer ─────────────────────────────────────────────
# A second distilled judge (``Jannchie/silva-luna``) with the same architecture
# and the same [0, 1] output domain as SILVA, so it reuses the bucket edges. It
# is a *different taste*, not a better one — both are stored side by side so a
# post can be sorted / filtered by either.
SILVA_LUNA = ScorerSpec(name="silva_luna", buckets=SILVA_SCORE_BUCKETS)

# All aesthetic scorers, keyed by their DB ``scorer`` name.
SCORERS: dict[str, ScorerSpec] = {SILVA.name: SILVA, SILVA_LUNA.name: SILVA_LUNA}
