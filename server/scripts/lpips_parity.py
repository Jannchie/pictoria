"""Parity check: our LPIPS implementation vs the upstream ``dghs-imgutils`` one.

Why this exists: the 0.45 "same picture" threshold is not ours. It is calibrated
by imgutils on an anime differential dataset against *their* preprocessing --
bilinear resize to a square 400, HWC to CHW, /255, alpha composited onto white.
Any deviation (a different resample filter, a preserved aspect ratio, PIL's
plain ``convert("RGB")`` on a transparent PNG) silently moves the distance
scale, and the threshold stops meaning what the benchmark says it means. So we
copied their preprocessing, and this script proves the copy is faithful.

``dghs-imgutils`` is deliberately *not* a dependency of this project: it pins
numpy < 2 and drags in opencv-contrib and scikit-learn, which would downgrade
numpy under torch / transformers / scikit-image. It only ever runs here, in a
throwaway environment.

Usage (three steps, from ``server/``)::

    uv run python scripts/lpips_parity.py sample --out .lpips/pairs.json
    uv run python scripts/lpips_parity.py ours   --pairs .lpips/pairs.json --out .lpips/ours.json
    uv run --isolated --no-project --with dghs-imgutils --with pillow \\
        python scripts/lpips_parity.py imgutils --pairs .lpips/pairs.json --out .lpips/theirs.json
    uv run python scripts/lpips_parity.py compare .lpips/ours.json .lpips/theirs.json

The ``imgutils`` step is the isolated one; it imports nothing from this project.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from paths import thumbnails_root

#: Pairs to compare. Enough to cover the distance range without making the
#: isolated install worth automating.
DEFAULT_SAMPLE = 50

#: The parity bar. LPIPS distances live in roughly [0, 1] and the threshold sits
#: at 0.40, so 1e-4 is three orders of magnitude below any decision this number
#: takes part in -- while still tight enough to catch a wrong resample filter.
TOLERANCE = 1e-4



def cmd_sample(args) -> int:
    root = thumbnails_root()
    if not root.is_dir():
        print(f"no thumbnails at {root}", file=sys.stderr)
        return 1

    # 只扫一层能收到的量已经足够，rglob 整个目录在 17 万张的库上要等很久。
    files = sorted(p for p in root.iterdir() if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})
    if len(files) < 4:
        print(f"only {len(files)} thumbnails found, need at least 4", file=sys.stderr)
        return 1

    rng = random.Random(args.seed)  # noqa: S311  # sampling, not crypto
    pairs: list[tuple[str, str]] = []
    # 一半取排序上相邻的两张：同一次导入 / 同一个帖子的文件名相邻，它们之间才有
    # 落在阈值附近的距离。全随机对几乎全是 0.7 以上，对拍不到有意义的区间。
    half = args.count // 2
    for _ in range(half):
        i = rng.randrange(len(files) - 1)
        pairs.append((str(files[i]), str(files[i + 1])))
    while len(pairs) < args.count:
        a, b = rng.sample(range(len(files)), 2)
        pairs.append((str(files[a]), str(files[b])))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(pairs, indent=2), encoding="utf-8")
    print(f"wrote {len(pairs)} pairs to {args.out}")
    return 0


def cmd_ours(args) -> int:
    # 延迟到这里才 import：它拉起 onnxruntime，而 sample/imgutils 两个子命令用不上。
    from ai.lpips import pair_distances  # noqa: PLC0415

    pairs = json.loads(args.pairs.read_text(encoding="utf-8"))
    distances = pair_distances([(Path(a), Path(b)) for a, b in pairs])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(distances, indent=2), encoding="utf-8")
    print(f"wrote {len(distances)} distances to {args.out}")
    return 0


def cmd_imgutils(args) -> int:
    from imgutils.metrics import lpips_difference  # noqa: PLC0415  # only present in the isolated env

    pairs = json.loads(args.pairs.read_text(encoding="utf-8"))
    distances = [float(lpips_difference(a, b)) for a, b in pairs]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(distances, indent=2), encoding="utf-8")
    print(f"wrote {len(distances)} distances to {args.out}")
    return 0


def cmd_compare(args) -> int:
    ours = json.loads(args.ours.read_text(encoding="utf-8"))
    theirs = json.loads(args.theirs.read_text(encoding="utf-8"))
    if len(ours) != len(theirs):
        print(f"length mismatch: {len(ours)} vs {len(theirs)}", file=sys.stderr)
        return 1

    deltas = [abs(a - b) for a, b in zip(ours, theirs, strict=True)]
    worst = max(range(len(deltas)), key=deltas.__getitem__)
    print(f"n={len(deltas)}  max|delta|={deltas[worst]:.3e} (pair #{worst}: ours={ours[worst]:.6f} theirs={theirs[worst]:.6f})")
    print(f"distance range: ours [{min(ours):.4f}, {max(ours):.4f}]  theirs [{min(theirs):.4f}, {max(theirs):.4f}]")
    # 分布也要看：两边都挤在 0.7 以上说明样本里根本没有近似对，那么"通过"只
    # 证明了两个实现对不相干的图一样地不相干，没有验证到阈值附近。
    near = sum(1 for d in ours if d < 0.6)
    print(f"pairs below 0.6: {near}/{len(ours)}")

    if deltas[worst] > TOLERANCE:
        print(f"FAIL: max delta exceeds {TOLERANCE:g}", file=sys.stderr)
        return 1
    print(f"OK: every pair agrees within {TOLERANCE:g}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_sample = sub.add_parser("sample", help="pick pairs of thumbnails to compare")
    p_sample.add_argument("--out", type=Path, required=True)
    p_sample.add_argument("--count", type=int, default=DEFAULT_SAMPLE)
    p_sample.add_argument("--seed", type=int, default=20260906)
    p_sample.set_defaults(func=cmd_sample)

    p_ours = sub.add_parser("ours", help="compute distances with ai.lpips")
    p_ours.add_argument("--pairs", type=Path, required=True)
    p_ours.add_argument("--out", type=Path, required=True)
    p_ours.set_defaults(func=cmd_ours)

    p_theirs = sub.add_parser("imgutils", help="compute distances with dghs-imgutils (isolated env)")
    p_theirs.add_argument("--pairs", type=Path, required=True)
    p_theirs.add_argument("--out", type=Path, required=True)
    p_theirs.set_defaults(func=cmd_imgutils)

    p_cmp = sub.add_parser("compare", help="compare two distance files")
    p_cmp.add_argument("ours", type=Path)
    p_cmp.add_argument("theirs", type=Path)
    p_cmp.set_defaults(func=cmd_compare)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
