"""Pydantic models that map 1:1 to SQLite rows.

These are the *internal* DB entities, separate from the API DTOs in
``scheme.py``. Each entity covers exactly one table's columns; joined data
(tags, colors, waifu score) is composed at the Repository layer into dicts
that ``PostDetailPublic`` / ``PostPublic`` validate from.

Storage notes:
- Timestamps are stored as ISO 8601 strings (SQLite has no native timestamp).
  Pydantic's ``datetime`` validator parses ISO strings transparently.
- ``posts.dominant_color`` is stored as a sqlite-vec BLOB (3 x float32).
  The validator below decodes BLOB bytes / JSON strings (from
  ``vec_to_json``) / pre-decoded lists into ``list[float]``.
"""

from __future__ import annotations

import json
import struct
from datetime import datetime  # noqa: TC003  # Pydantic needs runtime types
from pathlib import Path  # noqa: TC003  # Pydantic needs runtime types
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, ConfigDict

import shared


def _decode_dominant_color(v: Any) -> list[float] | None:
    if v is None or isinstance(v, list):
        return v
    if isinstance(v, str):
        # JSON form (e.g. `vec_to_json(dominant_color)` in SELECT)
        return json.loads(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        n = len(b) // 4
        return list(struct.unpack(f"{n}f", b))
    msg = f"Cannot decode dominant_color from {type(v).__name__}"
    raise ValueError(msg)


DominantColor = Annotated[list[float] | None, BeforeValidator(_decode_dominant_color)]


class _Entity(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)


# ---------- tag_groups -----------------------------------------------
class TagGroup(_Entity):
    id: int
    name: str
    parent_id: int | None = None
    color: str = "#000000"
    created_at: datetime
    updated_at: datetime


# ---------- tags -----------------------------------------------------
class Tag(_Entity):
    name: str
    group_id: int | None = None
    created_at: datetime
    updated_at: datetime


# ---------- posts ----------------------------------------------------
class Post(_Entity):
    id: int
    file_path: str
    file_name: str
    extension: str
    full_path: str
    width: int
    height: int
    aspect_ratio: float | None = None
    published_at: datetime | None = None
    score: int = 0
    rating: int = 0
    description: str = ""
    meta: str = ""
    sha256: str = ""
    size: int = 0
    source: str = ""
    caption: str = ""
    dominant_color: DominantColor = None
    thumbhash: str | None = None
    created_at: datetime
    updated_at: datetime

    # --- convenience accessors (not stored) ---
    @property
    def absolute_path(self) -> Path:
        return shared.target_dir / self.full_path

    @property
    def thumbnail_path(self) -> Path:
        return shared.thumbnails_dir / self.full_path


POST_COLUMNS = (
    "id, file_path, file_name, extension, full_path, width, height, "
    "aspect_ratio, published_at, score, rating, description, meta, "
    "sha256, size, source, caption, dominant_color, thumbhash, "
    "created_at, updated_at"
)


# ---------- post_has_tag --------------------------------------------
class PostHasTag(_Entity):
    post_id: int
    tag_name: str
    is_auto: bool = False


# ---------- post_has_color ------------------------------------------
class PostHasColor(_Entity):
    post_id: int
    order: int
    color: int


# ---------- post_vectors --------------------------------------------
class PostVector(_Entity):
    post_id: int
    embedding: list[float]


# ---------- post_waifu_scores ---------------------------------------
class PostWaifuScore(_Entity):
    post_id: int
    score: float = 0.0
