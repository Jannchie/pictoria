from typing import Annotated, ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException, NotFoundException
from litestar.params import Parameter
from litestar.status_codes import HTTP_404_NOT_FOUND, HTTP_409_CONFLICT, HTTP_422_UNPROCESSABLE_ENTITY
from msgspec import Meta, Struct
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Tag, TagGroup
from scheme import Result, TagPublic

MAX_TAG_LENGTH = 200


class TagCreate(Struct):
    name: Annotated[str, Meta(min_length=1, max_length=MAX_TAG_LENGTH)]
    group_id: int | None = None


class TagUpdate(Struct):
    group_id: int | None = None


class TagDelete(Struct):
    name: Annotated[str, Meta(min_length=1, max_length=MAX_TAG_LENGTH)]


class TagBatchDelete(Struct):
    name_list: Annotated[list[Annotated[str, Meta(max_length=MAX_TAG_LENGTH)]], Meta(min_length=1)]


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

    @litestar.get("/")
    async def list_tags(
        self,
        session: AsyncSession,
        prev: Annotated[str | None, Parameter(max_length=MAX_TAG_LENGTH)],
        limit: Annotated[int, Parameter(gt=0, le=1000)] = 100,
    ) -> list[TagPublic]:
        """
        List all tags with pagination support.
        The cursor is used to paginate through the results, and the limit specifies the number of results per page.
        """
        stmt = select(Tag).order_by(Tag.name).limit(limit)
        if prev:
            stmt = stmt.where(Tag.name > prev)
        return [TagPublic.model_validate(tag) for tag in (await session.scalars(stmt)).all()]

    @litestar.put("/{name:str}")
    async def update_tag(self, session: AsyncSession, name: str, data: TagUpdate) -> Result:
        """
        Update an existing tag with the given name.
        Users can optionally specify a new group ID to associate the tag with a tag group.
        """
        tag = await session.get(Tag, name)
        if not tag:
            detail = f"Tag '{name}' does not exist."
            raise NotFoundException(detail=detail, status_code=HTTP_404_NOT_FOUND)

        tag.name = data.name.strip()
        tag.group_id = data.group_id
        return Result(msg=f"Tag '{name}' updated successfully.")

    @litestar.delete("/{name:str}")
    async def delete_tag(self, session: AsyncSession, name: str) -> None:
        """
        Delete a tag with the given name.
        """
        await session.execute(delete(Tag).where(Tag.name == name))

    @litestar.delete("/")
    async def delete_tags(self, session: AsyncSession, data: TagBatchDelete) -> None:
        """
        Delete multiple tags with the given names.
        """
        await session.execute(delete(Tag).where(Tag.name.in_(data.name_list)))

    @litestar.get("/groups")
    async def list_tag_group(self, session: AsyncSession) -> list[TagGroup]:
        """List all tag groups."""
        stmt = select(TagGroup)
        return (await session.scalars(stmt)).all()
