from __future__ import annotations

import sys
import types

import numpy as np
import pytest


@pytest.fixture
def fake_encoders(monkeypatch: pytest.MonkeyPatch):
    """Inject fake ai.clip / ai.siglip_embed to avoid loading the real ML stack.

    Each fake encoder returns a constant (1, dim) tensor stand-in (numpy is
    enough, since get_text_vec only calls .cpu().numpy()[0]).
    """

    class _FakeTensor:
        def __init__(self, arr: np.ndarray) -> None:
            self._arr = arr

        def cpu(self) -> _FakeTensor:
            return self

        def numpy(self) -> np.ndarray:
            return self._arr

    def make_module(dim: int) -> types.ModuleType:
        mod = types.ModuleType("fake")
        mod.calculate_text_features = lambda _t: _FakeTensor(
            np.ones((1, dim), dtype=np.float32),
        )
        mod.calculate_image_features = lambda _p: _FakeTensor(
            np.ones((1, dim), dtype=np.float32),
        )
        return mod

    monkeypatch.setitem(sys.modules, "ai.clip", make_module(768))
    monkeypatch.setitem(sys.modules, "ai.siglip_embed", make_module(1152))


async def test_text_vec_uses_clip_by_default(fake_encoders, monkeypatch) -> None:
    import shared
    from server.utils.vec import get_text_vec

    monkeypatch.setattr(shared, "search_embedding_backend", "clip")
    vec = await get_text_vec("hello")
    assert vec.shape == (768,)


async def test_text_vec_uses_siglip_when_selected(fake_encoders, monkeypatch) -> None:
    import shared
    from server.utils.vec import get_text_vec

    monkeypatch.setattr(shared, "search_embedding_backend", "siglip2")
    vec = await get_text_vec("你好")
    assert vec.shape == (1152,)
