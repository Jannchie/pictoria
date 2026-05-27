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
from ai.torch_runtime import DEVICE, DTYPE, patch_features_to_tensor, to_rgb

MODEL_ID = "google/siglip2-so400m-patch14-384"
EMBED_DIM = 1152


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
        return model.get_image_features(pixel_values=pixel_values).float()


def calculate_image_features_batch(images: Sequence[ImageInput]) -> torch.Tensor:
    """Encode a batch of images in a single GPU forward; returns ``(N, 1152)``."""
    if not images:
        return torch.empty(0, device=DEVICE)
    pil_images = [
        to_rgb(Image.open(img)) if isinstance(img, Path | str) else to_rgb(img)
        for img in images
    ]
    try:
        model = get_model()
        processor = get_processor()
        inputs = processor(images=pil_images, return_tensors="pt").to(DEVICE)
        pixel_values = inputs.pixel_values.to(dtype=DTYPE)
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
    inputs = processor(text=text, return_tensors="pt", padding="max_length").to(DEVICE)
    with torch.inference_mode():
        # .float(): see calculate_image_features — bf16 can't go to numpy.
        return model.get_text_features(**inputs).float()
