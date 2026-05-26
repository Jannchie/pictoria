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
from functools import cache
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

from ai.hf_loader import load_local_first

MODEL_ID = "google/siglip2-so400m-patch14-384"
EMBED_DIM = 1152

_device = "cuda" if torch.cuda.is_available() else "cpu"
_dtype = torch.bfloat16 if _device == "cuda" else torch.float32


@cache
def get_model() -> AutoModel:
    model = load_local_first(AutoModel.from_pretrained, MODEL_ID, device_map=_device)
    model = model.to(dtype=_dtype)
    model.eval()
    _patch_features_to_tensor(model)
    return model


def _patch_features_to_tensor(model: AutoModel) -> None:
    # transformers 5.x may return a BaseModelOutputWithPooling from
    # get_{image,text}_features instead of the bare projected tensor; the
    # downstream code expects a tensor, so unwrap .pooler_output uniformly.
    for attr in ("get_image_features", "get_text_features"):
        original = getattr(model, attr, None)
        if original is None:
            continue

        def wrapper(*args: object, _orig: object = original, **kwargs: object) -> object:
            out = _orig(*args, **kwargs)  # type: ignore[operator]
            return getattr(out, "pooler_output", out)

        setattr(model, attr, wrapper)


@cache
def get_processor() -> AutoProcessor:
    return load_local_first(AutoProcessor.from_pretrained, MODEL_ID)


ImageInput = Image.Image | Path | str


def _to_rgb(img: Image.Image) -> Image.Image:
    return img if img.mode == "RGB" else img.convert("RGB")


def calculate_image_features(image: ImageInput) -> torch.Tensor:
    if isinstance(image, Path | str):
        image = Image.open(image)
    image = _to_rgb(image)
    model = get_model()
    processor = get_processor()
    inputs = processor(images=image, return_tensors="pt").to(_device)
    pixel_values = inputs.pixel_values.to(dtype=_dtype)
    with torch.inference_mode():
        # .float(): the model runs in bf16 but bf16 tensors can't go through
        # numpy() downstream, so match ai.clip's float32 output contract.
        return model.get_image_features(pixel_values=pixel_values).float()


def calculate_image_features_batch(images: Sequence[ImageInput]) -> torch.Tensor:
    """Encode a batch of images in a single GPU forward; returns ``(N, 1152)``."""
    if not images:
        return torch.empty(0, device=_device)
    pil_images = [
        _to_rgb(Image.open(img)) if isinstance(img, Path | str) else _to_rgb(img)
        for img in images
    ]
    try:
        model = get_model()
        processor = get_processor()
        inputs = processor(images=pil_images, return_tensors="pt").to(_device)
        pixel_values = inputs.pixel_values.to(dtype=_dtype)
        with torch.inference_mode():
            # .float(): see calculate_image_features — bf16 can't go to numpy.
            return model.get_image_features(pixel_values=pixel_values).float()
    finally:
        _close_opened(pil_images, images)


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
    inputs = processor(text=text, return_tensors="pt", padding="max_length").to(_device)
    with torch.inference_mode():
        # .float(): see calculate_image_features — bf16 can't go to numpy.
        return model.get_text_features(**inputs).float()
