"""Vector encoding for cross-language cairnq payloads.

The TS twin is ``packages/contracts/src/codec.ts`` — read that file for *why*
this is base64'd raw float32 rather than a JSON array of numbers (体积 3.4x,
plus decimal round-tripping is lossy in a way that shows up as last-digit
score drift). The fixture in ``test_codec.py`` and the one in
``codec.test.ts`` are the same seven numbers and the same base64 string, so a
change to byte order or encoding on either side turns both red.
"""

from __future__ import annotations

import base64

import numpy as np

#: SigLIP 2 embedding width. A payload row that decodes to anything else is a
#: protocol error, not a recoverable input — see :func:`decode_vector`.
SIGLIP2_DIM = 1152


def encode_vector(vec: np.ndarray) -> str:
    """``float32`` array → base64. Native little-endian, matching the TS side."""
    return base64.b64encode(np.asarray(vec, dtype=np.float32).tobytes()).decode()


def decode_vector(b64: str, *, dim: int = SIGLIP2_DIM) -> np.ndarray:
    """base64 → ``float32`` array of ``dim``.

    The width is checked rather than inferred: a truncated payload would
    otherwise reshape into a plausible-looking shorter vector and the head
    would score noise instead of failing.
    """
    arr = np.frombuffer(base64.b64decode(b64), dtype=np.float32)
    if arr.size != dim:
        msg = f"expected a {dim}-d vector, decoded {arr.size} floats"
        raise ValueError(msg)
    return arr
