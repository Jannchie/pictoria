"""Image-file handlers: rotate (direction, metadata, atomicity), thumbnails, caption upload, the decode pool."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

import numpy as np
import pytest
import torch
from PIL import Image, PngImagePlugin

from worker import handlers

if TYPE_CHECKING:
    from pathlib import Path

# A 3x2 image whose four corners are distinguishable: red top-left, green
# top-right, blue bottom-left, white bottom-right.
CORNERS = {(0, 0): (255, 0, 0), (2, 0): (0, 255, 0), (0, 1): (0, 0, 255), (2, 1): (255, 255, 255)}


def _corner_image() -> Image.Image:
    img = Image.new("RGB", (3, 2), (128, 128, 128))
    for xy, rgb in CORNERS.items():
        img.putpixel(xy, rgb)
    return img


@pytest.fixture
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path.resolve()
    monkeypatch.setattr(handlers, "_ROOT", root)
    return root


async def _rotate(library: Path, name: str, *, clockwise: bool) -> dict:
    return await handlers.handle_rotate(
        {
            "originalPath": str(library / name),
            "thumbnailPath": str(library / ".pictoria/thumbnails" / name),
            "clockwise": clockwise,
        },
    )


# ─── rotate ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("clockwise", [True, False])
async def test_rotate_matches_the_old_rotate_direction(library: Path, clockwise: bool) -> None:
    src = _corner_image()
    src.save(library / "a.png")
    expected = src.rotate(-90 if clockwise else 90, expand=True)

    result = await _rotate(library, "a.png", clockwise=clockwise)

    with Image.open(library / "a.png") as out:
        assert out.size == (2, 3)
        assert np.array_equal(np.asarray(out.convert("RGB")), np.asarray(expected))
    assert (result["width"], result["height"]) == (2, 3)
    if clockwise:
        # A quarter turn clockwise puts the old bottom-left (blue) at top-left.
        with Image.open(library / "a.png") as out:
            assert out.convert("RGB").getpixel((0, 0)) == (0, 0, 255)


async def test_rotate_png_is_lossless_and_keeps_text_and_icc(library: Path) -> None:
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "masterpiece, 1girl\nSteps: 28")
    info.add_itxt("Comment", "日本語", "ja", "コメント")
    icc = b"fake-icc-profile-bytes"
    rng = np.random.default_rng(0)
    src = Image.fromarray(rng.integers(0, 256, (40, 60, 3), dtype=np.uint8))
    src.save(library / "b.png", pnginfo=info, icc_profile=icc)

    await _rotate(library, "b.png", clockwise=True)
    await _rotate(library, "b.png", clockwise=False)

    with Image.open(library / "b.png") as out:
        assert np.array_equal(np.asarray(out), np.asarray(src))  # two quarter turns back: bit-exact
        assert out.text["parameters"] == "masterpiece, 1girl\nSteps: 28"
        assert out.text["Comment"] == "日本語"
        assert out.info["icc_profile"] == icc


async def test_rotate_jpeg_keeps_exif_but_drops_orientation_and_keeps_subsampling(library: Path) -> None:
    from PIL import JpegImagePlugin

    rng = np.random.default_rng(1)
    src = Image.fromarray(rng.integers(0, 256, (64, 96, 3), dtype=np.uint8))
    exif = Image.Exif()
    exif[0x010F] = "TestCam"  # Make
    exif[0x0112] = 6  # Orientation
    src.save(library / "c.jpg", exif=exif.tobytes(), quality=95, subsampling=0)

    await _rotate(library, "c.jpg", clockwise=True)

    with Image.open(library / "c.jpg") as out:
        assert out.size == (64, 96)
        assert out.getexif().get(0x010F) == "TestCam"
        assert 0x0112 not in out.getexif()
        assert JpegImagePlugin.get_sampling(out) == 0


async def test_rotate_leaves_no_temp_file_and_a_failed_save_keeps_the_original(library: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _corner_image().save(library / "d.png")
    before = (library / "d.png").read_bytes()

    def broken_save(*_args, **_kwargs):
        msg = "disk full"
        raise OSError(msg)

    monkeypatch.setattr(Image.Image, "save", broken_save)
    with pytest.raises(OSError, match="disk full"):
        await _rotate(library, "d.png", clockwise=True)
    assert (library / "d.png").read_bytes() == before
    assert sorted(p.name for p in library.iterdir() if p.is_file()) == ["d.png"]  # noqa: ASYNC240


# ─── thumbnails ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("size", [(3001, 2003), (6000, 999), (401, 7000), (1601, 1601), (400, 300)])
def test_jpeg_thumbnail_draft_keeps_the_full_decode_dimensions(tmp_path: Path, size: tuple[int, int]) -> None:
    from utils import create_thumbnail, create_thumbnail_by_image

    rng = np.random.default_rng(2)
    Image.fromarray(rng.integers(0, 256, (size[1], size[0], 3), dtype=np.uint8)).save(tmp_path / "big.jpg")
    create_thumbnail(tmp_path / "big.jpg", tmp_path / "draft.jpg")
    with Image.open(tmp_path / "big.jpg") as full:
        full.load()
        create_thumbnail_by_image(full, tmp_path / "full.jpg")
    with Image.open(tmp_path / "draft.jpg") as a, Image.open(tmp_path / "full.jpg") as b:
        assert a.size == b.size
        assert a.mode == b.mode


# ─── caption upload ─────────────────────────────────────────────────────────


def test_caption_upload_is_a_small_rgb_jpeg(tmp_path: Path) -> None:
    import base64
    import io

    pytest.importorskip("openai")
    from ai.make_captions import OpenAIImageAnnotator

    Image.new("RGBA", (2000, 1000), (10, 20, 30, 128)).save(tmp_path / "x.png")
    image = OpenAIImageAnnotator.load_upload_image(tmp_path / "x.png")
    assert image.mode == "RGB"
    assert max(image.size) == 512

    encoded = OpenAIImageAnnotator.get_img_base64(None, image)  # type: ignore[arg-type]
    with Image.open(io.BytesIO(base64.b64decode(encoded))) as decoded:
        assert decoded.format == "JPEG"


# ─── the shared decode pool ─────────────────────────────────────────────────


def test_preprocess_each_collects_per_item_and_restores_threads() -> None:
    from ai.torch_runtime import preprocess_each, preprocess_pool

    before = torch.get_num_threads()
    seen_threads: list[int] = []

    def fn(x: int) -> int:
        seen_threads.append(torch.get_num_threads())
        if x == 2:
            msg = "bad"
            raise ValueError(msg)
        return x * 10

    out = preprocess_each(fn, [0, 1, 2, 3])
    assert out[:2] == [0, 10]
    assert isinstance(out[2], ValueError)
    assert out[3] == 30
    assert torch.get_num_threads() == before
    assert set(seen_threads) == {1}
    assert preprocess_pool() is preprocess_pool()


def test_basics_runs_on_its_own_pool(library: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    names: list[str] = []

    def fake(item, _path, _thumb):
        names.append(threading.current_thread().name)
        return {"postId": item["postId"], "colorError": None}

    monkeypatch.setattr(handlers, "_compute_basics", fake)
    (library / "a.png").write_bytes(b"x")
    item = {
        "postId": 1,
        "path": str(library / "a.png"),
        "thumbnailPath": str(library / ".pictoria/thumbnails/a.png"),
        "hasSha256": False,
        "hasArthash": False,
        "hasColor": False,
    }
    result = asyncio.run(handlers.handle_basics({"items": [item]}))
    assert [r["postId"] for r in result["rows"]] == [1]
    assert names
    assert all(n.startswith("basics") for n in names)
