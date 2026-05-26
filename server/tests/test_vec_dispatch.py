from __future__ import annotations

import sys
import types

import numpy as np
import pytest

from server.utils.vec import get_text_vec


@pytest.fixture
def fake_encoder(monkeypatch: pytest.MonkeyPatch):
    """Inject a fake ai.siglip_embed to avoid loading the real ML stack.

    The fake encoder returns a constant (1, 1152) tensor stand-in (numpy is
    enough, since get_text_vec only calls .cpu().numpy()[0]).
    """

    class _FakeTensor:
        def __init__(self, arr: np.ndarray) -> None:
            self._arr = arr

        def cpu(self) -> _FakeTensor:
            return self

        def numpy(self) -> np.ndarray:
            return self._arr

    mod = types.ModuleType("fake")
    mod.calculate_text_features = lambda _t: _FakeTensor(
        np.ones((1, 1152), dtype=np.float32),
    )
    mod.calculate_image_features = lambda _p: _FakeTensor(
        np.ones((1, 1152), dtype=np.float32),
    )
    monkeypatch.setitem(sys.modules, "ai.siglip_embed", mod)


@pytest.mark.usefixtures("fake_encoder")
async def test_text_vec_uses_siglip() -> None:
    vec = await get_text_vec("你好")
    assert vec.shape == (1152,)
