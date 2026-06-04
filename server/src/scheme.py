from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from services.gallery_dl_import import GalleryDLStats


class DTOBaseModel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        alias_generator=to_camel,
    )


class TagGroupPublic(DTOBaseModel):
    id: int
    name: str
    color: str


class TagPublic(DTOBaseModel):
    name: str
    group: TagGroupPublic | None


class TagWithCountPublic(TagPublic):
    count: int


class TagGroupTagPublic(DTOBaseModel):
    name: str


class TagGroupWithTagsPublic(DTOBaseModel):
    tags: list["TagPublic"]


class TagWithGroupPublic(DTOBaseModel):
    group: TagGroupPublic | None
    name: str
    updated_at: datetime
    created_at: datetime


class PostHasTagPublic(DTOBaseModel):
    is_auto: bool
    tag_info: TagWithGroupPublic


class PostHasColorPublic(DTOBaseModel):
    order: int
    color: int


class WaifuScorePublic(DTOBaseModel):
    score: float


class AestheticScorePublic(DTOBaseModel):
    scorer: str
    score: float


class PostPublic(DTOBaseModel):
    id: int
    file_path: str
    file_name: str
    extension: str
    full_path: str
    width: int | None
    height: int | None
    aspect_ratio: float | None
    updated_at: datetime
    created_at: datetime
    score: int
    rating: int
    description: str
    meta: str
    sha256: str
    size: int
    source: str
    caption: str
    colors: list[PostHasColorPublic]
    published_at: datetime | None
    dominant_color: list[float] | None
    arthash: str | None
    # Near-duplicate grouping: NULL => this post is canonical (visible);
    # non-NULL => it is a hidden member pointing at its canonical representative.
    canonical_post_id: int | None = None
    # How many hidden members this (canonical) post has; 0 when not a group head.
    group_member_count: int = 0
    waifu_score: WaifuScorePublic | None
    aesthetic_scores: list[AestheticScorePublic] = []


class PostDetailPublic(PostPublic):
    tags: list[PostHasTagPublic]


@dataclass
class Result:
    msg: str


class UrlImportStatus(DTOBaseModel):
    """Lifecycle of the single background gallery-dl URL import task.

    One in-memory instance lives on ``app.state``; each new import replaces
    it with a fresh instance that the background task mutates as it
    progresses, so a status poll always reflects the current/last run.
    Process-local by design — restart clears it.
    """

    state: Literal["idle", "running", "done", "failed"] = "idle"
    url: str | None = None
    # Populated when state == "done". Composes the service's dataclass so the
    # stat shape is single-sourced — a new stat field shows up here (and in
    # the OpenAPI schema) without a parallel field list to keep in lockstep.
    stats: GalleryDLStats | None = None
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    sync_triggered: bool = False
