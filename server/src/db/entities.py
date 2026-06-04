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

from datetime import datetime  # noqa: TC003  # Pydantic needs runtime types
from pathlib import Path  # noqa: TC003  # Pydantic needs runtime types
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict

import shared
from db.helpers import decode_dominant_color

DominantColor = Annotated[list[float] | None, BeforeValidator(decode_dominant_color)]


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
    arthash: str | None = None
    canonical_post_id: int | None = None
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
    "sha256, size, source, caption, dominant_color, arthash, "
    "canonical_post_id, created_at, updated_at"
)
