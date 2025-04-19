from collections.abc import Generator
from dataclasses import dataclass
from datetime import datetime

from litestar.dto import DTOConfig, DTOField, DTOFieldDefinition
from litestar.plugins.sqlalchemy import SQLAlchemyDTO
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import DeclarativeBase

from models import Post, Tag


class TagGroupPublic(BaseModel):
    id: int
    name: str
    color: str

    class Config:
        from_attributes = True


class TagPublic(BaseModel):
    name: str

    class Config:
        from_attributes = True


class TagGroupWithTagsPublic(TagGroupPublic):
    tags: list["TagPublic"]


class TagWithGroupPublic(TagPublic):
    group: TagGroupPublic | None


class PostHasTagPublic(BaseModel):
    is_auto: bool
    tag_info: TagWithGroupPublic

    class Config:
        from_attributes = True


class PostHasColorPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    order: int
    color: int


class PostPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
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


class PostWithTagPublic(PostPublic):
    tags: list[PostHasTagPublic]


class MixedDTO(SQLAlchemyDTO):
    @classmethod
    def generate_field_definitions(cls, model_type: type) -> Generator[DTOFieldDefinition, None, None]:
        properties = cls.get_property_fields(model_type)
        yield from super().generate_field_definitions(model_type)
        for key, property_field in properties.items():
            if key.startswith("_"):
                continue

            yield DTOFieldDefinition.from_field_definition(
                property_field,
                model_name=model_type.__name__,
                default_factory=None,
                dto_field=DTOField(mark="read-only"),
            )


class Base(DeclarativeBase): ...


class PostDTO(MixedDTO[Post]):
    config = DTOConfig(
        rename_strategy="camel",
        max_nested_depth=2,
        exclude={
            "dominant_color_np",
            "tags.0.post_id",
            "tags.0.tag_name",
            "colors.0.post_id",
        },
        experimental_codegen_backend=False,
    )


class TagDTO(MixedDTO[Tag]):
    config = DTOConfig(rename_strategy="camel")


class PostWithTagDTO(MixedDTO[Post]):
    config = DTOConfig(
        rename_strategy="camel",
        max_nested_depth=2,
        exclude={
            "dominant_color_np",
            "tags.0.post_id",
            "tags.0.tag_name",
            "colors.0.post_id",
        },
    )


@dataclass
class Result:
    msg: str
