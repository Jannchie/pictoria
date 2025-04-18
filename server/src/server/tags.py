from typing import Annotated, ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException, NotFoundException
from litestar.status_codes import HTTP_409_CONFLICT, HTTP_422_UNPROCESSABLE_ENTITY
from msgspec import Meta, Struct
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from models import Tag, TagGroup
from scheme import Result

MAX_TAG_LENGTH = 200


class TagCreate(Struct):
    name: Annotated[str, Meta(min_length=1, max_length=MAX_TAG_LENGTH)]
    group_id: int | None = None


class TagDelete(Struct):
    name: Annotated[str, Meta(min_length=1, max_length=MAX_TAG_LENGTH)]


class TagsController(Controller):
    path = "/tags"
    tags: ClassVar[list[str]] = ["Tags"]

    @litestar.post("/")
    async def create_tag(self, session: AsyncSession, data: TagCreate) -> Result:
        """
        Create a new tag with the given name.
        Users can optionally specify a group ID to associate the tag with a tag group.
        """
        tag_name = data.name.strip()
        existing_tag = await session.get(Tag, tag_name)
        if existing_tag:
            detail = f"Tag '{tag_name}' already exists."
            raise HTTPException(detail=detail, status_code=HTTP_409_CONFLICT)
        if data.group_id:
            group = await session.get(TagGroup, data.group_id)
            if not group:
                detail = f"Tag group with ID {data.group_id} does not exist."
                raise NotFoundException(detail=detail, status_code=HTTP_422_UNPROCESSABLE_ENTITY)

        tag = Tag(name=tag_name, group_id=data.group_id)
        session.add(tag)
        return Result(msg=f"Tag '{tag_name}' created successfully.")

    @litestar.delete("/{name:str}")
    async def delete_tag(self, session: AsyncSession, name: str) -> None:
        await session.execute(delete(Tag).where(Tag.name == name))
