"""Unit tests for the aesthetic-scorer registry (``db.scorers``).

Pure string/data assertions — no DB. These pin the SQL fragments the query
layer derives from a ``ScorerSpec`` so a scorer rename or a formula change is a
deliberate, visible edit.
"""

from __future__ import annotations

from db.scorers import SCORERS, SILVA, SILVA_SCORE_BUCKETS, ScorerSpec


class TestSilvaSpec:
    def test_registered_under_its_name(self) -> None:
        assert SCORERS["silva"] is SILVA
        assert SILVA.name == "silva"

    def test_alias_is_derived_from_name(self) -> None:
        assert SILVA.alias == "pas_silva"

    def test_default_affine_map_is_0_1_to_1_5(self) -> None:
        # 0 -> 1, 1 -> 5 on the manual star scale.
        assert SILVA.scale == 4.0
        assert SILVA.offset == 1.0

    def test_buckets_are_the_silva_edges(self) -> None:
        assert SILVA.buckets is SILVA_SCORE_BUCKETS
        assert SILVA.buckets["A"] == (0.8, 1.0001)
        assert SILVA.buckets["E"] == (0.0, 0.2)


class TestSqlFragments:
    def test_join_sql_default_alias(self) -> None:
        assert SILVA.join_sql() == (
            "LEFT JOIN post_aesthetic_scores pas_silva "
            "ON pas_silva.post_id = p.id AND pas_silva.scorer = 'silva'"
        )

    def test_join_sql_alias_override(self) -> None:
        # The folder-aggregate query historically joins under alias ``a``.
        assert SILVA.join_sql(alias="a") == (
            "LEFT JOIN post_aesthetic_scores a "
            "ON a.post_id = p.id AND a.scorer = 'silva'"
        )

    def test_join_sql_table_alias_override(self) -> None:
        assert SILVA.join_sql(table_alias="q").startswith(
            "LEFT JOIN post_aesthetic_scores pas_silva ON pas_silva.post_id = q.id",
        )

    def test_score_and_null_cols(self) -> None:
        assert SILVA.score_col() == "pas_silva.score"
        assert SILVA.null_col() == "pas_silva.post_id"
        assert SILVA.score_col("a") == "a.score"

    def test_score_expr_lifts_to_manual_scale(self) -> None:
        # This is exactly the expression the discrepancy sort subtracts p.score from.
        assert SILVA.score_expr() == "pas_silva.score * 4.0 + 1.0"


class TestScorerSpecGeneric:
    def test_custom_scorer_derives_everything_from_name(self) -> None:
        spec = ScorerSpec(name="foo", buckets={}, scale=2.0, offset=0.5)
        assert spec.alias == "pas_foo"
        assert spec.join_sql() == (
            "LEFT JOIN post_aesthetic_scores pas_foo "
            "ON pas_foo.post_id = p.id AND pas_foo.scorer = 'foo'"
        )
        assert spec.score_expr() == "pas_foo.score * 2.0 + 0.5"
