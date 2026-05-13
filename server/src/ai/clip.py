from functools import cache
from pathlib import Path

import torch
from PIL import Image
from rich import print
from transformers import AutoModel, AutoProcessor

device = "cuda"


@cache
def get_clip_model() -> AutoModel:
    model = AutoModel.from_pretrained(
        "openai/clip-vit-large-patch14",
        device_map=device,
    )
    # transformers 5.x changed `CLIPModel.get_{image,text}_features` to return
    # a `BaseModelOutputWithPooling` instead of the bare projected-pooled tensor
    # that 4.x returned. waifu_scorer (and our own code below) still expect the
    # old tensor return shape, so unwrap `.pooler_output` here.
    _patch_clip_features_to_tensor(model)
    return model


def _patch_clip_features_to_tensor(model: AutoModel) -> None:
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
    return AutoProcessor.from_pretrained(
        "openai/clip-vit-large-patch14",
        use_fast=False,
    )


def calculate_image_features(image: Image.Image | Path | str) -> torch.Tensor:
    if isinstance(image, Path | str):
        image = Image.open(image)
    model = get_clip_model()
    processor = get_processor()
    inputs = processor(images=image, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        return model.get_image_features(pixel_values=inputs.pixel_values)


def calculate_text_features(text: str | list[str]) -> torch.Tensor:
    """Calculate CLIP text features for the given prompt(s)."""
    if isinstance(text, str):
        text = [text]
    model = get_clip_model()
    processor = get_processor()
    inputs = processor(text=text, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        return model.get_text_features(**inputs)


if __name__ == "__main__":
    model = get_clip_model()
    image = Image.open(R"E:\pictoria\server\demo\9c34d98c7242c2b174fa0f7617f1d736.jpg")

    texts = ["high-quality art", "low-quality art"]
    # important: we pass `padding=max_length` since the model was trained with this
    inputs = get_processor()(text=texts, images=image, return_tensors="pt", padding=True)
    print(inputs.pixel_values.shape)
    intputs = inputs.to(device)

    with torch.no_grad():
        image_features = model.get_image_features(pixel_values=inputs.pixel_values)
        text_features = model.get_text_features(input_ids=inputs.input_ids)
        print(image_features.shape)
        print(text_features.shape)
        print(model(**inputs))
