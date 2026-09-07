"""Calibrate the LPIPS "same picture" threshold on this library's own images.

``imgutils`` reports adjusted rand score 0.995 at 0.45, but that was measured on
their dataset, not ours. This script answers the only question that decides
whether variant grouping is worth building: on *these* images, does LPIPS
separate "the same drawing, edited" from "a different drawing"?

Positives are synthesised, because that is the only way to get ground truth
without labelling by hand -- crop, an added speech bubble, a censor mosaic and a
colour shift are four of the five differential kinds we are chasing. The fifth,
an expression edit, cannot be synthesised and has to be sampled by hand; this
script deliberately does not pretend otherwise.

Negatives come in two grades, and the hard grade is the one that matters: two
files adjacent in sort order are usually the same artist and often the same
character from the same import, which is exactly the pair a too-loose threshold
merges by mistake.

Usage (from ``server/``)::

    uv run python scripts/lpips_calibrate.py --count 60
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ai.lpips import LPIPS_SAME_THRESHOLD_DEFAULT, pair_distances
from paths import thumbnails_root


def _load(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGB")


def edit_crop(image: Image.Image, rng: random.Random) -> Image.Image:
    """Keep ~70% of the area, offset at random -- a re-crop, not a centre crop."""
    scale = 0.837  # sqrt(0.7)
    width, height = image.size
    box_w, box_h = int(width * scale), int(height * scale)
    left = rng.randint(0, width - box_w)
    top = rng.randint(0, height - box_h)
    return image.crop((left, top, left + box_w, top + box_h))


def edit_textbox(image: Image.Image, _rng: random.Random) -> Image.Image:
    """A white dialogue box across the bottom, the way a translation edit lands."""
    out = image.copy()
    width, height = out.size
    band = max(24, int(height * 0.18))
    draw = ImageDraw.Draw(out)
    draw.rectangle((0, height - band, width, height), fill=(255, 255, 255))
    try:
        font = ImageFont.load_default(size=max(12, band // 3))
    except TypeError:  # Pillow < 10 has no size argument
        font = ImageFont.load_default()
    draw.text((8, height - band + band // 4), "SAMPLE DIALOGUE TEXT", fill=(0, 0, 0), font=font)
    return out


def edit_mosaic(image: Image.Image, _rng: random.Random) -> Image.Image:
    """Pixelate a central patch -- the censored / uncensored pair."""
    out = image.copy()
    width, height = out.size
    box = (int(width * 0.35), int(height * 0.35), int(width * 0.65), int(height * 0.65))
    patch = out.crop(box)
    small = patch.resize((max(1, patch.width // 12), max(1, patch.height // 12)), Image.Resampling.NEAREST)
    out.paste(small.resize(patch.size, Image.Resampling.NEAREST), box)
    return out


def edit_hue(image: Image.Image, _rng: random.Random) -> Image.Image:
    """Rotate hue by 30 degrees -- a rough stand-in for a recolour."""
    hsv = np.asarray(image.convert("HSV")).astype(np.int16)
    hsv[..., 0] = (hsv[..., 0] + 21) % 256  # 30 degrees on PIL's 0-255 hue scale
    return Image.fromarray(hsv.astype(np.uint8), mode="HSV").convert("RGB")


EDITS = {
    "crop 70%": edit_crop,
    "text box": edit_textbox,
    "mosaic": edit_mosaic,
    "hue +30": edit_hue,
}


def _report(name: str, distances: list[float], threshold: float, *, positive: bool) -> None:
    array = np.asarray(distances)
    if positive:
        hit = float((array <= threshold).mean())
        verdict = f"recall {hit:6.1%}"
    else:
        hit = float((array <= threshold).mean())
        verdict = f"FALSE MERGE {hit:6.1%}"
    print(
        f"  {name:<14} n={len(array):<4} "
        f"p50={np.percentile(array, 50):.3f} p90={np.percentile(array, 90):.3f} "
        f"min={array.min():.3f} max={array.max():.3f}   {verdict}",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--count", type=int, default=60, help="source images to synthesise from")
    parser.add_argument("--seed", type=int, default=20260906)
    parser.add_argument("--threshold", type=float, default=LPIPS_SAME_THRESHOLD_DEFAULT)
    parser.add_argument("--work", type=Path, default=Path(".lpips/synth"))
    args = parser.parse_args()

    root = thumbnails_root()
    files = sorted(p for p in root.iterdir() if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})
    if len(files) < args.count * 2:
        print(f"only {len(files)} thumbnails, need {args.count * 2}", file=sys.stderr)
        return 1

    rng = random.Random(args.seed)  # noqa: S311  # sampling, not crypto
    picked = rng.sample(range(len(files) - 1), args.count)
    args.work.mkdir(parents=True, exist_ok=True)

    print(f"{args.count} source images from {root}\n")
    print(f"positives (same drawing, edited) -- want distance <= {args.threshold}")

    for label, edit in EDITS.items():
        pairs: list[tuple[Path, Path]] = []
        for n, index in enumerate(picked):
            source = files[index]
            edited = edit(_load(source), rng)
            out = args.work / f"{label.replace(' ', '_').replace('%', 'pct').replace('+', 'p')}_{n}.png"
            edited.save(out)
            pairs.append((source, out))
        _report(label, pair_distances(pairs), args.threshold, positive=True)

    print(f"\nnegatives (different drawings) -- want distance > {args.threshold}")
    # 相邻两张：同一次导入、常常同画师同角色。错并最可能发生在这里，所以它才是
    # 有意义的负样本；随机对只能证明"两张毫不相干的图确实不相干"。
    adjacent = [(files[i], files[i + 1]) for i in picked]
    _report("adjacent", pair_distances(adjacent), args.threshold, positive=False)

    random_pairs: list[tuple[Path, Path]] = []
    for _ in range(args.count):
        a, b = rng.sample(range(len(files)), 2)
        random_pairs.append((files[a], files[b]))
    _report("random", pair_distances(random_pairs), args.threshold, positive=False)

    print(f"\nsynthesised images left in {args.work} for eyeballing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
