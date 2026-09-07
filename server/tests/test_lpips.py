"""Tests for the LPIPS arbiter.

The preprocessing tests are the important ones and always run: the 0.45
threshold is calibrated against imgutils' exact pipeline, so a drift in resize,
channel order, scaling or alpha handling silently changes what the number means.
``scripts/lpips_parity.py`` checks the same thing end to end against the real
package; these pin the pieces that are cheap to pin.

The inference tests need the two ONNX files, so they skip when the hub cache
does not have them.
"""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image


def _weights_available() -> bool:
    from huggingface_hub import hf_hub_download

    from ai.lpips import DIFF_FILE, FEATURE_FILE, MODEL_REPO

    try:
        for name in (FEATURE_FILE, DIFF_FILE):
            hf_hub_download(MODEL_REPO, name, local_files_only=True)
    except OSError:
        return False
    return True


needs_weights = pytest.mark.skipif(not _weights_available(), reason="LPIPS ONNX weights not in the local hub cache")


def _write(path, image: Image.Image):
    image.save(path)
    return path


def test_preprocess_shape_scale_and_dtype() -> None:
    from ai.lpips import INPUT_SIZE, preprocess

    encoded = preprocess(Image.new("RGB", (123, 45), (255, 128, 0)))

    assert encoded.shape == (3, INPUT_SIZE, INPUT_SIZE)
    assert encoded.dtype == np.float32
    # CHW, /255, no ImageNet normalisation -- channel 0 is the red plane.
    assert encoded[0].min() == pytest.approx(1.0)
    assert encoded[1].mean() == pytest.approx(128 / 255, abs=1e-3)
    assert encoded[2].max() == pytest.approx(0.0)


def test_preprocess_ignores_aspect_ratio() -> None:
    """A square output from a wide input is imgutils' behaviour, not a bug.

    It is also the mechanism behind the one differential kind LPIPS cannot
    judge: a crop changes the aspect ratio, so every spatial position shifts and
    the distance blows up. Pinning it here keeps that trade-off explicit.
    """
    from ai.lpips import INPUT_SIZE, preprocess

    assert preprocess(Image.new("RGB", (800, 100))).shape == (3, INPUT_SIZE, INPUT_SIZE)


def test_preprocess_composites_alpha_onto_white() -> None:
    """Transparent pixels must become white, not the RGB hiding underneath.

    ``Image.convert("RGB")`` -- what ``ai.torch_runtime.to_rgb`` does -- keeps
    the colour stored under a fully transparent pixel, so a PNG saved with black
    under transparency would read as black here and as white in imgutils. That
    is a threshold-invalidating difference on exactly the kind of file an
    illustration library is full of.
    """
    from ai.lpips import preprocess

    transparent_black = Image.new("RGBA", (8, 8), (0, 0, 0, 0))

    assert preprocess(transparent_black).min() == pytest.approx(1.0)
    assert np.asarray(transparent_black.convert("RGB")).max() == 0


def test_pair_distances_empty_does_not_load_models() -> None:
    from ai.lpips import pair_distances

    assert pair_distances([]) == []


def test_features_computed_once_per_distinct_path(monkeypatch, tmp_path) -> None:
    """Three pairs over four images must encode four images, not six."""
    from ai import lpips

    batch_sizes: list[int] = []

    def feature_run(names, feeds):
        batch_sizes.append(len(feeds["input"]))
        return [np.zeros((len(feeds["input"]), 2, 2, 2), dtype=np.float32) for _ in names]

    def diff_run(_names, feeds):
        return [np.arange(len(feeds["feat_x_0"]), dtype=np.float32).reshape(-1, 1, 1, 1)]

    monkeypatch.setattr(
        lpips,
        "_sessions",
        lambda: (SimpleNamespace(run=feature_run), SimpleNamespace(run=diff_run)),
    )

    paths = [_write(tmp_path / f"{i}.png", Image.new("RGB", (16, 16), (i * 40, 0, 0))) for i in range(4)]
    distances = lpips.pair_distances([(paths[0], paths[1]), (paths[0], paths[2]), (paths[1], paths[3])])

    assert len(distances) == 3
    assert sum(batch_sizes) == 4


@needs_weights
def test_identical_images_have_zero_distance(tmp_path) -> None:
    from ai.lpips import pair_distances

    image = Image.effect_noise((64, 64), 32).convert("RGB")
    left = _write(tmp_path / "a.png", image)
    right = _write(tmp_path / "b.png", image)

    (distance,) = pair_distances([(left, right)])
    assert distance == pytest.approx(0.0, abs=1e-4)


@needs_weights
def test_local_edit_stays_far_below_the_threshold(tmp_path) -> None:
    """A text box over the bottom fifth is the arbiter's core case.

    Calibrated on this library the same edit lands at ~0.16 against a 0.45 cut;
    this asserts the loose half of that gap so the test survives a different
    synthetic image without going vacuous.
    """
    from PIL import ImageDraw

    from ai.lpips import LPIPS_SAME_THRESHOLD_DEFAULT, pair_distances

    base = Image.effect_noise((200, 200), 48).convert("RGB")
    edited = base.copy()
    ImageDraw.Draw(edited).rectangle((0, 160, 200, 200), fill=(255, 255, 255))

    (distance,) = pair_distances([(_write(tmp_path / "a.png", base), _write(tmp_path / "b.png", edited))])
    assert distance < LPIPS_SAME_THRESHOLD_DEFAULT


# ---- handler-side pair resolution -------------------------------------------
# `_resolve_pairs` is the arbiter's half of the containment rule every worker
# payload goes through. Its two-tier policy has teeth: an escaping path is
# reported as a failure (TS blacklists it permanently) while a missing file is
# merely dropped (the row is fine, the file is gone, sync will notice).


@pytest.fixture
def library(tmp_path, monkeypatch):
    from worker import handlers

    monkeypatch.setattr(handlers, "_ROOT", tmp_path.resolve())
    return tmp_path


def _item(post_id: int, path) -> dict:
    return {"postId": post_id, "path": str(path)}


def test_resolve_pairs_accepts_both_sides_inside_the_root(library) -> None:
    from worker.handlers import _resolve_pairs

    left = _write(library / "a.png", Image.new("RGB", (4, 4)))
    right = _write(library / "b.png", Image.new("RGB", (4, 4)))

    pairs, failures = _resolve_pairs([{"a": _item(1, left), "b": _item(2, right)}])

    assert failures == []
    assert [(a, b) for a, b, _, _ in pairs] == [(1, 2)]


def test_resolve_pairs_reports_an_escaping_side(library, tmp_path_factory) -> None:
    from worker.handlers import _resolve_pairs

    inside = _write(library / "a.png", Image.new("RGB", (4, 4)))
    outside = _write(tmp_path_factory.mktemp("elsewhere") / "b.png", Image.new("RGB", (4, 4)))

    pairs, failures = _resolve_pairs([{"a": _item(1, inside), "b": _item(2, outside)}])

    assert pairs == []
    assert [(f["a"], f["b"]) for f in failures] == [(1, 2)]
    assert "escapes the library root" in failures[0]["error"]


def test_resolve_pairs_drops_a_missing_side_without_failing_it(library) -> None:
    from worker.handlers import _resolve_pairs

    present = _write(library / "a.png", Image.new("RGB", (4, 4)))

    pairs, failures = _resolve_pairs([{"a": _item(1, present), "b": _item(2, library / "gone.png")}])

    assert pairs == []
    assert failures == []
