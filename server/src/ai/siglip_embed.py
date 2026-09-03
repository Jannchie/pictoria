"""SigLIP 2 image/text embedding forward pass (DB-free).

The image/text encoders used once the search backend migrates from CLIP
(``ai.clip``) to SigLIP 2. Structurally a drop-in for ``ai.clip``: image
features feed the backfill worker into ``post_vectors_siglip2``, and text
features feed ``/search/text`` for multilingual text-to-image search.

The backbone is ``google/siglip2-so400m-patch14-384`` (1152-d, multilingual
text tower). It shares no weights with the SigLIP **v1** so400m used by the
aesthetic scorer, so the two load as independent models on the GPU.
"""

import contextlib
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from pathlib import Path

import torch
import torch.nn.functional as F  # noqa: N812
from PIL import Image
from transformers import AutoModel, AutoProcessor

from ai.hf_loader import load_local_first
from ai.torch_runtime import DEVICE, DTYPE, patch_features_to_tensor, to_rgb

MODEL_ID = "google/siglip2-so400m-patch14-384"
EMBED_DIM = 1152

# `calculate_image_features_batch` 里解码 + 预处理用的线程数。见那里的长注释。
PREPROCESS_WORKERS = 8


@cache
def get_model() -> AutoModel:
    model = load_local_first(AutoModel.from_pretrained, MODEL_ID, device_map=DEVICE)
    model = model.to(dtype=DTYPE)
    model.eval()
    patch_features_to_tensor(model)
    return model


@cache
def get_processor() -> AutoProcessor:
    return load_local_first(AutoProcessor.from_pretrained, MODEL_ID)


ImageInput = Image.Image | Path | str


def calculate_image_features(image: ImageInput) -> torch.Tensor:
    if isinstance(image, Path | str):
        image = Image.open(image)
    image = to_rgb(image)
    model = get_model()
    processor = get_processor()
    inputs = processor(images=image, return_tensors="pt").to(DEVICE)
    pixel_values = inputs.pixel_values.to(dtype=DTYPE)
    with torch.inference_mode():
        # .float(): the model runs in bf16 but bf16 tensors can't go through
        # numpy() downstream, so match ai.clip's float32 output contract.
        # F.normalize: SigLIP's recipe is `sigmoid(scale * (x_norm @ y_norm.T) + bias)`,
        # so the embeddings we store / compare should be L2-normalised. The vec0 cosine
        # metric makes ranking scale-invariant, but normalising at the source keeps the
        # raw cosine in `[-1, 1]` for the sigmoid step in the search layer.
        features = model.get_image_features(pixel_values=pixel_values).float()
        return F.normalize(features, p=2, dim=-1)


def calculate_image_features_batch(images: Sequence[ImageInput]) -> torch.Tensor:
    """Encode a batch of images in a single GPU forward; returns ``(N, 1152)``.

    Decode + preprocess run on a thread pool; the GPU forward is still one
    whole-batch call. Rationale below (Chinese, like the rest of this repo's
    "why" comments) — RUF002 forbids the full-width punctuation in a docstring,
    so it lives as comments.
    """
    # 为什么要并行：这一整个函数跑在 ``asyncio.to_thread`` 里，而 GPU 队列是
    # ``concurrency=1``（``worker/main.py``），所以解码 + 预处理期间 GPU 全程空转。
    # batch=32 实测一批 5.4 s 里只有 0.64 s 是 forward，剩下 4.7 s 是单线程 CPU 在
    # 逐张 decode/resize。22.9 万张要跑 7000+ 批，这部分是整轮 backfill 的大头。
    #
    # 为什么是线程池而不是进程池：这里的重活是 PIL 的 JPEG/PNG 解码和
    # ``SiglipImageProcessor`` 的 resize/normalize（PIL 的 C 层 + numpy），两者都在
    # 计算期间释放 GIL，所以线程能真正并行。进程池反而更差：输入可能是已经在内存里
    # 的 ``Image.Image``，输出是 32x3x384x384 的 float32（约 56 MB 一批），跨进程都要
    # pickle 搬一遍，序列化开销直接吃掉省下的时间；模型和 CUDA 上下文也没法共享。
    #
    # 为什么是 8：扫过了。24 核机器上 batch=32 的 fused 耗时中位数 ——
    # 1 线程 6890 ms、2 线程 4930、4 线程 3227、6 线程 2399、8 线程 2623、
    # 12 线程 2312、16 线程 2090、24 线程 2025。拐点在 6~8，之后曲线基本平掉：
    # PIL/numpy 只在自己的 C 循环里放 GIL，夹在中间的 Python 胶水挡住了继续扩展。
    # 再加线程换来的不到 20% 收益，代价是每个在途线程都攥着一张解码后的全尺寸位图，
    # 而这条流水线还要和同机的 GPU 进程共用内存，不划算。
    #
    # 输出逐位相同这件事是**验证过的**，不是假设：``processor(images=[单张])`` 逐张
    # 跑再 ``torch.cat``，与原来的 ``processor(images=[整批])`` 对同一批 32 张真实库图
    # 做 ``torch.equal(a, b)`` 断言为 True（换过多批图重复验证）。SigLIP 的 image
    # processor 把每张图独立缩放到固定的 384x384，没有 batch 级 padding，所以逐图和
    # 整批本来就该一致 —— 但这条路径写进 ``post_vectors_siglip2`` 的向量要和存量
    # 22.9 万条混在同一张表里比较，"该一致"不够。模型 forward 和 ``F.normalize``
    # 一个字没动，pixel_values 相同则输出必然相同。
    if not images:
        return torch.empty(0, device=DEVICE)
    processor = get_processor()
    # 按下标预分配：worker 只写 opened[i]，永远不 append，所以顺序天然等于入参顺序，
    # 也就不需要 as_completed 那套回填。
    opened: list[Image.Image | None] = [None] * len(images)

    def _prepare(index: int) -> torch.Tensor:
        src = images[index]
        pil = to_rgb(Image.open(src)) if isinstance(src, Path | str) else to_rgb(src)
        # 先登记再预处理：预处理阶段抛错时，finally 里仍然关得掉这张已经打开的图。
        # 登记的是 (pil, src) 这一对本身，`_close_opened` 的 `opened is src` 判断
        # 因此和串行版本完全一样 —— 我们只关自己 Image.open 出来的那些。
        opened[index] = pil
        return processor(images=[pil], return_tensors="pt").pixel_values

    try:
        with ThreadPoolExecutor(max_workers=min(PREPROCESS_WORKERS, len(images))) as pool:
            futures = [pool.submit(_prepare, i) for i in range(len(images))]
        # 退出 with 即 shutdown(wait=True)，所有线程都已结束，opened 定型。然后按下标
        # 顺序取结果：单张失败仍然让整批抛异常（不吞），且抛出的是下标最小的那个，
        # 与串行版本的行为一致。代价是失败批次里后面的图白算了一遍 —— 失败是罕见
        # 路径（还有 run_with_fallback 兜底），换来的是不留悬空线程的确定性清理。
        tiles = [future.result() for future in futures]
        model = get_model()
        pixel_values = torch.cat(tiles, dim=0).to(DEVICE).to(dtype=DTYPE)
        with torch.inference_mode():
            # .float(): see calculate_image_features — bf16 can't go to numpy.
            features = model.get_image_features(pixel_values=pixel_values).float()
            return F.normalize(features, p=2, dim=-1)
    finally:
        done = [(pil, src) for pil, src in zip(opened, images, strict=True) if pil is not None]
        _close_opened([pil for pil, _ in done], [src for _, src in done])


def _close_opened(pil_images: list[Image.Image], original: Iterable[ImageInput]) -> None:
    for opened, src in zip(pil_images, original, strict=True):
        if opened is src:
            continue
        with contextlib.suppress(Exception):
            opened.close()


def calculate_text_features(text: str | list[str]) -> torch.Tensor:
    """Multilingual text features (same space as image features); ``(N, 1152)``."""
    if isinstance(text, str):
        text = [text]
    model = get_model()
    processor = get_processor()
    # SigLIP is trained with fixed padding="max_length"; keep parity with the
    # upstream inference recipe.
    inputs = processor(text=text, return_tensors="pt", padding="max_length").to(DEVICE)
    with torch.inference_mode():
        # .float(): see calculate_image_features — bf16 can't go to numpy.
        features = model.get_text_features(**inputs).float()
        return F.normalize(features, p=2, dim=-1)


@cache
def get_logit_scale_bias() -> tuple[float, float]:
    """SigLIP's learned scale/bias for the official sigmoid scoring recipe.

    The paper / model card scores a (text, image) pair as
    ``sigmoid(logit_scale.exp() * (text_norm @ image_norm.T) + logit_bias)``.
    Cached as plain Python floats so retrieval code can apply the sigmoid
    without re-touching torch on every request.
    """
    model = get_model()
    scale = float(model.logit_scale.exp().item())
    bias = float(model.logit_bias.item())
    return scale, bias
