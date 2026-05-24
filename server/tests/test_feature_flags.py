from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _restore_flag():
    import shared

    original = shared.search_embedding_backend
    yield
    shared.search_embedding_backend = original


@pytest.mark.parametrize(
    ("env_value", "expected"),
    [
        (None, "siglip2"),  # unset -> default backend
        ("", "siglip2"),  # empty -> default backend
        ("clip", "clip"),
        ("siglip2", "siglip2"),
        ("SIGLIP2", "siglip2"),
        ("garbage", "siglip2"),  # unrecognised -> fall back to default (siglip2)
    ],
)
def test_backend_flag_parsing(
    monkeypatch: pytest.MonkeyPatch, env_value: str | None, expected: str,
) -> None:
    import shared
    import utils

    if env_value is None:
        monkeypatch.delenv("SEARCH_EMBEDDING_BACKEND", raising=False)
    else:
        monkeypatch.setenv("SEARCH_EMBEDDING_BACKEND", env_value)
    utils.prepare_feature_flags()
    assert shared.search_embedding_backend == expected
