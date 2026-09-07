"""Tests for the near-pair search behind both dedup and variant recall.

The distance and truncation options are what the grey band rests on, and the
truncation one has a failure mode that is invisible from the outside: if the
top-K cut is applied per row and then folded to the upper triangle by keeping
only ``j > i``, a pair that only ranks on its *lower* side disappears. That
turns a union into an intersection and silently drops variants.
"""

from __future__ import annotations

import numpy as np
import pytest

from worker.dedup import find_near_pairs

CHUNK = 2


def _rows(*vectors: list[float]) -> np.ndarray:
    matrix = np.asarray(vectors, dtype=np.float32)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)


def _indices(pairs: list[list[int | float]]) -> list[list[int]]:
    """Just the row indices -- for the assertions that are about *which* pairs."""
    return [[int(pair[0]), int(pair[1])] for pair in pairs]


def test_fewer_than_two_rows_has_no_pairs() -> None:
    assert find_near_pairs(_rows([1.0, 0.0, 0.0]), 0.1, CHUNK) == []


def test_identical_rows_pair_in_upper_triangle() -> None:
    matrix = _rows([1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0])

    assert _indices(find_near_pairs(matrix, 0.01, CHUNK)) == [[0, 1]]


def test_each_pair_appears_once() -> None:
    """Three mutually identical rows are three pairs, not six."""
    matrix = _rows([1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0])

    assert _indices(find_near_pairs(matrix, 0.01, CHUNK)) == [[0, 1], [0, 2], [1, 2]]


def test_every_pair_carries_its_cosine_distance() -> None:
    matrix = _rows([1.0, 0.0, 0.0], [1.0, 0.0, 0.0])

    (pair,) = find_near_pairs(matrix, 0.01, CHUNK)

    assert pair[:2] == [0, 1]
    # fp16 on CUDA, fp32 on CPU -- the tolerance covers the looser one.
    assert pair[2] == pytest.approx(0.0, abs=1e-3)


def test_max_per_row_keeps_pairs_ranked_by_either_side() -> None:
    """A pair that only ranks on its lower side must survive the cut.

    Similarities here: A-B 0.995, A-C 0.970, B-C 0.941, all inside the
    threshold. With K=1 each row keeps one neighbour: A keeps B, B keeps A, and
    C keeps A. So A-C is ranked by C alone -- an intersection would drop it --
    while B-C is ranked by neither and is the one that should go.
    """
    matrix = _rows([1.0, 0.0, 0.0], [1.0, 0.10, 0.0], [1.0, -0.25, 0.0])

    assert _indices(find_near_pairs(matrix, 0.07, CHUNK, max_per_row=1)) == [[0, 1], [0, 2]]
    # Without the cut all three pairs are near.
    assert _indices(find_near_pairs(matrix, 0.07, CHUNK)) == [[0, 1], [0, 2], [1, 2]]


def test_max_per_row_larger_than_the_library_is_a_no_op() -> None:
    matrix = _rows([1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0])

    assert _indices(find_near_pairs(matrix, 0.01, CHUNK, max_per_row=99)) == [[0, 1], [0, 2], [1, 2]]
