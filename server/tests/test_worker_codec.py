"""Cross-language vector codec — the twin of ``packages/contracts/src/codec.test.ts``.

Same seven numbers, same base64 string. If either side changes byte order or
encoding, both suites go red instead of one of them silently agreeing with
itself.
"""

from __future__ import annotations

import numpy as np
import pytest

from worker.codec import SIGLIP2_DIM, decode_vector, encode_vector

FIXTURE = np.array([0, 1, -1, 0.5, -0.5, 3.4028235e38, 1.1754944e-38], dtype=np.float32)
FIXTURE_B64 = "AAAAAAAAgD8AAIC/AAAAPwAAAL///39/AACAAA=="


def test_fixture_matches_the_typescript_side() -> None:
    assert encode_vector(FIXTURE) == FIXTURE_B64


def test_round_trip_is_bit_exact() -> None:
    assert np.array_equal(decode_vector(FIXTURE_B64, dim=len(FIXTURE)), FIXTURE)


def test_real_width_round_trips() -> None:
    vec = (np.sin(np.arange(SIGLIP2_DIM)) / 3).astype(np.float32)
    assert np.array_equal(decode_vector(encode_vector(vec)), vec)


def test_truncated_payload_raises_rather_than_reshaping() -> None:
    # A short vector must not quietly become a plausible shorter one — the head
    # would score noise and nothing would look wrong.
    short = encode_vector(np.zeros(64, dtype=np.float32))
    with pytest.raises(ValueError, match="expected a 1152-d vector"):
        decode_vector(short)
