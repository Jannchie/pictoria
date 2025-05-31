from dataclasses import dataclass
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


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


class WaifuScorerPublic(DTOBaseModel):
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
    md5: str
    size: int
    source: str
    caption: str
    colors: list[PostHasColorPublic]
    published_at: datetime | None
    dominant_color: list[float] | None
    waifu_scorer: WaifuScorerPublic | None


class PostDetailPublic(PostPublic):
    tags: list[PostHasTagPublic]


@dataclass
class Result:
    msg: str
