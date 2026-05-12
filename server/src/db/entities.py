"""Pydantic models that map 1:1 to DuckDB rows.

These are the *internal* DB entities, separate from the API DTOs in
``scheme.py``. Each entity covers exactly one table's columns; joined data
(tags, colors, waifu score) is composed at the Repository layer into dicts
that ``PostDetailPublic`` / ``PostPublic`` validate from.
"""

from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, ConfigDict

import shared


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
    dominant_color: list[float] | None = None
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
