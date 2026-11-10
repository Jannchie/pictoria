"""SigLIP 2 image/text embedding forward pass (DB-free).

The image/text encoders used once the search backend migrates from CLIP
(``ai.clip``) to SigLIP 2. Structurally a drop-in for ``ai.clip``: image
features feed the backfill worker into ``post_vectors_siglip2``, and text
features feed ``/search/text`` for multilingual text-to-image search.

The backbone is ``google/siglip2-so400m-patch14-384`` (1152-d, multilingual
text tower). It shares no weights with the SigLIP **v1** so400m used by the
aesthetic scorer, so the two load as independent models on the GPU.
"""

import threading
from collections.abc import Sequence
from functools import cache
from pathlib import Path

import torch
import torch.nn.functional as F  # noqa: N812
from PIL import Image
from transformers import AutoModel, AutoProcessor

from ai.hf_loader import load_local_first
from ai.torch_runtime import DEVICE, DTYPE, patch_features_to_tensor, preprocess_each, to_rgb

MODEL_ID = "google/siglip2-so400m-patch14-384"
EMBED_DIM = 1152


#: Serialises the first load. ``functools.cache`` does not: the ``embedding``
#: (GPU) and ``text-embed`` (interactive) queues run in different threads, and on
#: a cold start a backfill batch and a text search would both miss the cache and
#: both put a ~2 GB so400m on a card that is already close to full.
_load_lock = threading.Lock()


@cache
def _load_model() -> AutoModel:
    model = load_local_first(AutoModel.from_pretrained, MODEL_ID, device_map=DEVICE)
    model = model.to(dtype=DTYPE)
    model.eval()
    patch_features_to_tensor(model)
    return model


@cache
def _load_processor() -> AutoProcessor:
    return load_local_first(AutoProcessor.from_pretrained, MODEL_ID)


def get_model() -> AutoModel:
    with _load_lock:
        return _load_model()


def get_processor() -> AutoProcessor:
    with _load_lock:
        return _load_processor()


def warm() -> None:
    """Load the weights and the processor. Off-loop.

    Called before the fallback ladder so a load failure (download, VRAM) fails
    the task — which is retried — instead of failing every image one by one,
    which TS would blacklist.
    """
    get_model()
    get_processor()


ImageInput = Image.Image | Path | str


def _preprocess_one(src: ImageInput) -> torch.Tensor:
    """One image to its ``(1, 3, 384, 384)`` pixel values; closes what it opened."""
    if isinstance(src, Path | str):
        with Image.open(src) as opened:
            return get_processor()(images=[to_rgb(opened)], return_tensors="pt").pixel_values
    return get_processor()(images=[to_rgb(src)], return_tensors="pt").pixel_values


def preprocess_images(images: Sequence[ImageInput]) -> list[torch.Tensor | Exception]:
    """Decode + preprocess on the shared pool; one tile **or exception** per image.

    The decode half of the ladder (``worker.ladder``): an unreadable file comes
    back as its exception, in its slot, and the rest of the batch is unaffected.
    """
    # 池、线程数与 OpenMP 的理由见 ``ai.torch_runtime.preprocess_each``；下面只记 SigLIP 自己的实测。
    #
    # 为什么是 8：扫过了。24 核机器上 batch=32 的 fused 耗时中位数 ——
    # 1 线程 6890 ms、2 线程 4930、4 线程 3227、6 线程 2399、8 线程 2623、
    # 12 线程 2312、16 线程 2090、24 线程 2025。拐点在 6~8，之后曲线基本平掉。
    # 再加线程换来的不到 20% 收益，代价是每个在途线程都攥着一张解码后的全尺寸位图。
    #
    # 输出逐位相同这件事是**验证过的**，不是假设：``processor(images=[单张])`` 逐张
    # 跑再 ``torch.cat``，与 ``processor(images=[整批])`` 对同一批 32 张真实库图做
    # ``torch.equal(a, b)`` 断言为 True。SigLIP 的 image processor 把每张图独立缩放到
    # 固定的 384x384，没有 batch 级 padding，所以逐图和整批本来就该一致。
    return preprocess_each(_preprocess_one, images)


def encode_pixel_values(tiles: Sequence[torch.Tensor]) -> torch.Tensor:
    """The forward half: one whole-batch GPU call over decoded tiles; ``(N, 1152)``.

    ``.float()``: the model runs in bf16 but bf16 tensors can't go through
    ``numpy()`` downstream, so the output is float32 (``ai.clip``'s contract).
    ``F.normalize``: SigLIP's recipe is ``sigmoid(scale * (x_norm @ y_norm.T) + bias)``,
    so stored / compared embeddings are L2-normalised. The vec0 cosine metric makes
    ranking scale-invariant, but normalising at the source keeps the raw cosine in
    ``[-1, 1]`` for the sigmoid step in the search layer.
    """
    if not tiles:
        return torch.empty(0, device=DEVICE)
    model = get_model()
    pixel_values = torch.cat(list(tiles), dim=0).to(DEVICE).to(dtype=DTYPE)
    with torch.inference_mode():
        features = model.get_image_features(pixel_values=pixel_values).float()
        return F.normalize(features, p=2, dim=-1)


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
        # .float() / F.normalize: see encode_pixel_values.
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
