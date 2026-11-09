"""LPIPS perceptual distance between two images (DB-free, CPU, ONNX).

The judge for the variant-grouping grey band. SigLIP 2 answers "are these the
same *subject*", which is the wrong question for differential art: an expression
edit or an added speech bubble moves the semantic vector as much as a different
drawing of the same character does. LPIPS answers "are these the same *picture*"
by comparing CNN features position by position, so an edit confined to the face
or a text box only contributes where it actually is.

The weights are the two ONNX files under ``deepghs/imgutils-models``, which are
the ``richzhang/PerceptualSimilarity`` AlexNet variant: five conv stages
(64/192/384/256/256 channels) plus the paper's learnt 1x1 calibration layers,
split into a feature model and a diff model. ``imgutils`` reports adjusted rand
score 0.995 at threshold 0.45 on an anime differential dataset -- that number is
the reason this module exists, and it is why the preprocessing below is a
byte-for-byte copy of theirs rather than a reuse of what this repo already has.

Deliberately CPU. The 3090 is already carrying four models at ~23.7 GB, an
onnxruntime CUDA provider costs hundreds of MB more just to initialise, and one
400x400 AlexNet forward is ~20-40 ms on CPU -- fast enough for arbitration,
which only ever sees the pairs recall could not decide on its own.
"""

from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING

import numpy as np
import onnxruntime
from huggingface_hub import hf_hub_download
from PIL import Image

from shared import logger

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Mapping, Sequence
    from pathlib import Path

MODEL_REPO = "deepghs/imgutils-models"
FEATURE_FILE = "lpips/lpips_feature.onnx"
DIFF_FILE = "lpips/lpips_diff.onnx"

#: Both models are fixed at 400x400 by imgutils' `_image_resize`, and the 0.45
#: threshold is calibrated at that size. Not a tunable.
INPUT_SIZE = 400

#: 判"同一张画"的距离上限，与 `contracts/tasks.ts` 的 `LPIPS_SAME_THRESHOLD`
#: 同值（手工同步的孪生常量，理由和取值依据写在那边）。上游 imgutils 标的是 0.45，
#: 我们用 0.40。
#:
#: **这里没有任何代码读它** —— 判定是 TS 的事，这个模块只回距离。它存在只是给
#: `scripts/lpips_calibrate.py` 一个默认值，顺便让读这个文件的人知道这些数字
#: 最后会被拿去和什么比。
LPIPS_SAME_THRESHOLD_DEFAULT = 0.40

_FEATURE_OUTPUTS = ("feat_0", "feat_1", "feat_2", "feat_3", "feat_4")
_DIFF_X_INPUTS = ("feat_x_0", "feat_x_1", "feat_x_2", "feat_x_3", "feat_x_4")
_DIFF_Y_INPUTS = ("feat_y_0", "feat_y_1", "feat_y_2", "feat_y_3", "feat_y_4")

#: 每张图的五层特征约 6.4 MB（64x99x99 + 192x49x49 + 384x24x24 + 256x24x24 x2），
#: 所以这里的批大小是内存预算而不是吞吐旋钮：16 张 ≈ 100 MB 常驻，一个 64 对的
#: 仲裁批最坏 128 张唯一图也只是分 8 次走完。调大省不了多少 CPU，却会在一台已经
#: 被 GPU 进程吃掉大半内存的机器上（探针就是这么被 OOM 杀掉的）多一个爆点。
FEATURE_BATCH = 16

#: diff 模型只是十个特征图上的 1x1 卷积 + 空间平均，几乎不占时间，分组只为
#: 避免一次性把 N 对的两侧特征都 gather 成新数组。
DIFF_BATCH = 16

#: onnxruntime 默认会把机器上所有核都用上，两个 worker 并发时就是超额认购。
#: 与 `main.py` 里 CPU 队列的 concurrency 相乘应当不超过物理核数。
INTRA_OP_THREADS = 4

#: 两张图宽高比相差超过这个倍数，就先对齐再比（见 `overlap`）。
#:
#: 拉伸成正方形对裁切版/扩图版是致命的：每个空间位置都错开，距离被撑爆。2026-10-19
#: 在库里实测，SigLIP 距离 0.01–0.02 的灰带对里，宽高比一致的被 LPIPS 拒 4%，相差
#: 超过 10% 的被拒 66%；抽 40 对对齐后重算，33 对落回阈值内且逐一目检都是同一张画，
#: 其余 7 对（0.51–0.72）是真不同的画面，照旧被拒。宽高比一致的对不受影响 ——
#: 它们仍走原来那条按路径复用特征的路径。
ASPECT_TOLERANCE = 1.1

#: 对齐在灰度图上由粗到细做：只为找位置，不为判同。先在 ALIGN_COARSE_SIDE 长边上把
#: 两个方向 × ALIGN_STEPS 档全扫一遍挑出方向和档位，再在 ALIGN_LONG_SIDE 上只细化
#: 那一档左右 ALIGN_REFINE 档。skimage 的 match_template 在 256 上一次 ~11 ms，
#: 全扫 52 次就是每对 ~650 ms（实测）；粗扫 + 细化把它压到 ~100 ms 以内。
ALIGN_COARSE_SIDE = 96
ALIGN_LONG_SIDE = 256
ALIGN_REFINE = 2

#: 被包含的那张在另一张里最小占多大（相对于它能放下的最大尺寸），以及在
#: [ALIGN_MIN_COVER, 1] 上试多少档。裁切版通常贴满一条边（取 1 那档），26 档的
#: 步长 2% 留给"既裁切又缩放"的情形。
ALIGN_MIN_COVER = 0.5
ALIGN_STEPS = 26

#: 模板短边低于这么多像素就不试了：相关图会退化成噪声。
ALIGN_MIN_TEMPLATE = 16


def _download(filename: str) -> str:
    """Fetch one model file, local cache first.

    Same shape and same reason as ``ai.hf_loader.load_local_first``: the hub
    revalidates etags over the network on every call otherwise. That helper
    takes a ``from_pretrained``-style loader, which ``hf_hub_download`` is not,
    so the two-line retry is repeated rather than contorted.
    """
    try:
        return hf_hub_download(MODEL_REPO, filename, local_files_only=True)
    except OSError:
        logger.info(f"LPIPS model {filename!r} not in local cache; downloading from the hub...")
        return hf_hub_download(MODEL_REPO, filename)


@cache
def _sessions() -> tuple[onnxruntime.InferenceSession, onnxruntime.InferenceSession]:
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = INTRA_OP_THREADS
    providers = ["CPUExecutionProvider"]
    feature = onnxruntime.InferenceSession(_download(FEATURE_FILE), options, providers=providers)
    diff = onnxruntime.InferenceSession(_download(DIFF_FILE), options, providers=providers)
    return feature, diff


def preprocess(image: Image.Image) -> np.ndarray:
    """One image to the model's ``(3, 400, 400)`` float32 input.

    This mirrors ``imgutils``'s ``_image_encode`` exactly -- bilinear resize to
    a square (aspect ratio is *not* preserved), HWC to CHW, divide by 255, no
    ImageNet normalisation (the LPIPS scaling layer is baked into the graph).
    """
    # `Image.Resampling.BILINEAR` is imgutils' `Image.BILINEAR` -- the same
    # enum member, spelled the way Pillow 10+ types it.
    resized = _to_rgb(image).resize((INPUT_SIZE, INPUT_SIZE), resample=Image.Resampling.BILINEAR)
    array = np.asarray(resized).transpose((2, 0, 1))
    return (array / 255.0).astype(np.float32)


def _to_rgb(image: Image.Image) -> Image.Image:
    # 白底合成，而不是 `ai.torch_runtime.to_rgb` 的 convert("RGB")。两者对带 alpha
    # 的 PNG 给出不同像素（convert 直接丢掉 alpha 通道，等于把透明区当成它底下的
    # 原始 RGB 值），而 0.45 这个阈值是在 imgutils 的白底语义上标定的。差一个背景色
    # 就够让阈值失效，所以这里跟着它而不是跟着仓库里已有的那个。
    if image.mode == "RGBA":
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, image)
    if image.mode != "RGB":
        image = image.convert("RGB")
    return image


def _load(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return preprocess(image)


def _aspect_differs(left: Path, right: Path) -> bool:
    # Image.open 只读文件头，不解码像素。
    with Image.open(left) as a, Image.open(right) as b:
        ratio = (a.width / a.height) / (b.width / b.height)
    return max(ratio, 1 / ratio) > ASPECT_TOLERANCE


def _gray(image: Image.Image, scale: float) -> np.ndarray:
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return np.asarray(image.convert("L").resize(size, resample=Image.Resampling.BOX), dtype=np.float32)


_COVERS = np.linspace(1.0, ALIGN_MIN_COVER, ALIGN_STEPS)


def _placement(
    inner: Image.Image,
    outer: Image.Image,
    long_side: int,
    steps: Iterable[int],
) -> tuple[float, int, tuple[int, int, int, int]]:
    """Where ``inner`` best sits inside ``outer``: ``(ncc, step, box in outer's pixels)``.

    ``step`` indexes _COVERS: ``inner`` at that fraction of the largest size
    that fits. The correlation only locates the box; it is far too weak to say
    "same picture" (a real crop scored 0.54, unrelated pictures by the same
    artist 0.34-0.53), which stays LPIPS's job.
    """
    from skimage.feature import match_template  # noqa: PLC0415  # lazy: only aligned pairs need it

    scale = long_side / max(outer.size)
    field = _gray(outer, scale)
    fit = min(outer.width / inner.width, outer.height / inner.height)
    best = (-np.inf, 0, (0, 0, outer.width, outer.height))
    for step in steps:
        size = inner.width * fit * _COVERS[step], inner.height * fit * _COVERS[step]
        template = _gray(inner, size[0] * scale / inner.width)
        if min(template.shape) < ALIGN_MIN_TEMPLATE or any(t > f for t, f in zip(template.shape, field.shape, strict=True)):
            continue
        response = match_template(field, template)
        y, x = np.unravel_index(int(np.argmax(response)), response.shape)
        if response[y, x] > best[0]:
            left, top = x / scale, y / scale
            best = (float(response[y, x]), step, (round(left), round(top), round(left + size[0]), round(top + size[1])))
    return best


def overlap(left: Image.Image, right: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Cut a crop and its uncropped version down to the region they share.

    Either side may be the crop, so both placements are scanned coarsely and the
    better correlation picks the direction and size; only that size and its
    neighbours are then searched at full alignment resolution. The contained
    side is kept whole and the other is cut to the box it was found in. Both
    then go through ``preprocess`` as usual, so the threshold still compares two
    400x400 squares of the same framing.
    """
    left, right = _to_rgb(left), _to_rgb(right)
    every = range(ALIGN_STEPS)
    in_right = _placement(left, right, ALIGN_COARSE_SIDE, every)
    in_left = _placement(right, left, ALIGN_COARSE_SIDE, every)
    inner, outer, (_, step, _) = (left, right, in_right) if in_right[0] >= in_left[0] else (right, left, in_left)
    near = range(max(0, step - ALIGN_REFINE), min(ALIGN_STEPS, step + ALIGN_REFINE + 1))
    _, _, box = _placement(inner, outer, ALIGN_LONG_SIDE, near)
    return (left, right.crop(box)) if inner is left else (left.crop(box), right)


def _encode(count: int, load: Callable[[int], np.ndarray]) -> tuple[np.ndarray, ...]:
    feature, _ = _sessions()
    # Fill preallocated arrays in place rather than collecting per-batch chunks
    # and concatenating at the end. The five feature maps are ~6.4 MB per image,
    # so a 128-image task is ~820 MB -- and concatenating means both the chunks
    # and the result are live at once, doubling that in a process the module
    # docstring already describes as having no headroom.
    out: list[np.ndarray] | None = None
    for start in range(0, count, FEATURE_BATCH):
        batch = np.stack([load(i) for i in range(start, min(start + FEATURE_BATCH, count))])
        maps = feature.run(list(_FEATURE_OUTPUTS), {"input": batch})
        if out is None:
            out = [np.empty((count, *m.shape[1:]), dtype=np.float32) for m in maps]
        for level, m in enumerate(maps):
            out[level][start : start + len(batch)] = m
    if out is None:  # nothing to encode
        return ()
    return tuple(out)


def extract_features(paths: Sequence[Path]) -> tuple[np.ndarray, ...]:
    """Encode images into the five feature maps LPIPS compares.

    Returns five arrays shaped ``(len(paths), C, H, W)`` -- one per conv stage,
    in the order the diff model expects them.
    """
    return _encode(len(paths), lambda i: _load(paths[i]))


def _distances(features: tuple[np.ndarray, ...], left: Sequence[int], right: Sequence[int]) -> list[float]:
    _, diff = _sessions()
    out: list[float] = []
    for start in range(0, len(left), DIFF_BATCH):
        lo = np.asarray(left[start : start + DIFF_BATCH])
        hi = np.asarray(right[start : start + DIFF_BATCH])
        inputs: Mapping[str, np.ndarray] = {
            **{name: features[level][lo] for level, name in enumerate(_DIFF_X_INPUTS)},
            **{name: features[level][hi] for level, name in enumerate(_DIFF_Y_INPUTS)},
        }
        (output,) = diff.run(["output"], dict(inputs))
        out.extend(float(value) for value in np.asarray(output).reshape(-1))
    return out


def pair_distances(pairs: Iterable[tuple[Path, Path]]) -> list[float]:
    """LPIPS distance for each ``(left, right)`` pair, in input order.

    Features are computed once per distinct path within the call: a batch of
    pairs is not a batch of images, and an arbitration batch built by sorting on
    the lower post id puts many pairs sharing one side next to each other, so
    the saving is most of the work. It is deliberately *not* cached across
    calls -- 6.4 MB per image means even a modest LRU is hundreds of MB resident
    in a process that has none to spare.
    """
    pair_list = list(pairs)
    if not pair_list:
        return []

    out: list[float] = [0.0] * len(pair_list)
    aligned = [i for i, (left, right) in enumerate(pair_list) if _aspect_differs(left, right)]
    plain = sorted(set(range(len(pair_list))) - set(aligned))

    if plain:
        order: dict[Path, int] = {}
        for i in plain:
            for path in pair_list[i]:
                if path not in order:
                    order[path] = len(order)
        features = extract_features(list(order))
        distances = _distances(features, [order[pair_list[i][0]] for i in plain], [order[pair_list[i][1]] for i in plain])
        for i, distance in zip(plain, distances, strict=True):
            out[i] = distance
        del features  # free before the aligned half allocates its own

    if aligned:
        # The crops are pair-specific, so these features cannot be shared
        # across pairs: two encodes per pair, left at 2k and right at 2k+1.
        crops: list[np.ndarray] = []
        for i in aligned:
            left, right = pair_list[i]
            with Image.open(left) as a, Image.open(right) as b:
                crops.extend(preprocess(c) for c in overlap(a, b))
        features = _encode(len(crops), crops.__getitem__)
        distances = _distances(features, range(0, len(crops), 2), range(1, len(crops), 2))
        for i, distance in zip(aligned, distances, strict=True):
            out[i] = distance
    return out
