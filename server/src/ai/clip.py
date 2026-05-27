"""CLIP ViT-L/14 backbone loader.

Retained solely as the backbone for the waifu quality scorer
(``ai.waifu_scorer``), which feeds the CLIP model + processor into
``WaifuScorer``. Search / retrieval embeddings live in ``ai.siglip_embed``
(SigLIP 2, 1152d); this module no longer provides any retrieval feature
extraction.
"""

from functools import cache

from transformers import AutoModel, AutoProcessor

from ai.hf_loader import load_local_first
from ai.torch_runtime import patch_features_to_tensor

device = "cuda"


@cache
def get_clip_model() -> AutoModel:
    model = load_local_first(
        AutoModel.from_pretrained,
        "openai/clip-vit-large-patch14",
        device_map=device,
    )
    # transformers 5.x changed `CLIPModel.get_{image,text}_features` to return
    # a `BaseModelOutputWithPooling` instead of the bare projected-pooled tensor
    # that 4.x returned. waifu_scorer still expects the old tensor return shape,
    # so unwrap `.pooler_output` here.
    patch_features_to_tensor(model)
    return model


@cache
def get_processor() -> AutoProcessor:
    return load_local_first(
        AutoProcessor.from_pretrained,
        "openai/clip-vit-large-patch14",
        use_fast=False,
    )
