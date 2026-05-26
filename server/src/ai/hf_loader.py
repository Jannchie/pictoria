"""Local-cache-first loading for HuggingFace models.

transformers / huggingface_hub validate etags over the network on *every*
``from_pretrained`` even when the model is fully cached locally — a slow round
trip to huggingface.co (and a flood of httpx INFO logs). ``local_files_only=
True`` skips all that network access; on a genuine cache miss it raises
``OSError`` (transformers wraps the offline failure; huggingface_hub's
``LocalEntryNotFoundError`` subclasses ``OSError`` too), which we catch to retry
online and download once.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypeVar

from shared import logger

if TYPE_CHECKING:
    from collections.abc import Callable

T = TypeVar("T")


def load_local_first(loader: Callable[..., T], model_id: str, **kwargs: object) -> T:
    """Load ``model_id`` from the local HF cache first, downloading only on miss.

    ``loader`` is typically ``AutoModel.from_pretrained`` /
    ``AutoProcessor.from_pretrained``.
    """
    try:
        return loader(model_id, local_files_only=True, **kwargs)
    except OSError:
        logger.info(f"HF model {model_id!r} not in local cache; downloading from the hub…")
        return loader(model_id, **kwargs)
