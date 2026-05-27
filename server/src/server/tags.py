from collections.abc import Sequence
from typing import Annotated, ClassVar

import litestar
from litestar import Controller
from litestar.params import Parameter
from msgspec import Meta, Struct

from db.repositories.tags import TagGroupRepo, TagRepo
from scheme import Result, TagGroupPublic, TagPublic, TagWithCountPublic
from server.exceptions import TagGroupNotFoundError, TagNameExistsError, TagNameNotFoundError

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
    tags: ClassVar[Sequence[str] | None] = ("Tags",)  # type: ignore[assignment]

    @litestar.post("/")
    async def create_tag(self, tag_repo: TagRepo, tag_group_repo: TagGroupRepo, data: TagCreate) -> Result:
        """Create a new tag, optionally associated with a tag group."""
        tag_name = data.name.strip()
        existing = await tag_repo.get(tag_name)
        if existing:
            raise TagNameExistsError(tag_name)
        if data.group_id:
            group = await tag_group_repo.get(data.group_id)
            if not group:
                raise TagGroupNotFoundError(data.group_id)
        await tag_repo.create(tag_name, data.group_id)
        return Result(msg=f"Tag '{tag_name}' created successfully.")

    @litestar.get("/")
    async def list_tags(
        self,
        tag_repo: TagRepo,
        prev: Annotated[str | None, Parameter(max_length=MAX_TAG_LENGTH)] = None,
        limit: Annotated[int | None, Parameter(gt=0)] = None,
    ) -> list[TagWithCountPublic]:
        """List tags with post counts; cursor-paginated by tag name."""
        rows = await tag_repo.list_with_counts(prev=prev, limit=limit)
        return [TagWithCountPublic.model_validate(r) for r in rows]

    @litestar.put("/{name:str}")
    async def update_tag(self, tag_repo: TagRepo, tag_group_repo: TagGroupRepo, name: str, data: TagUpdate) -> TagPublic:
        """Reassign a tag to a different tag group."""
        tag = await tag_repo.get(name)
        if not tag:
            raise TagNameNotFoundError(name)
        if data.group_id:
            group = await tag_group_repo.get(data.group_id)
            if not group:
                raise TagGroupNotFoundError(data.group_id)
        updated = await tag_repo.update_group(name, data.group_id)
        if not updated:
            raise TagNameNotFoundError(name)
        group_obj = await tag_group_repo.get(updated.group_id) if updated.group_id else None
        return TagPublic.model_validate({
            "name": updated.name,
            "group": (
                {"id": group_obj.id, "name": group_obj.name, "color": group_obj.color}
                if group_obj else None
            ),
        })

    @litestar.delete("/{name:str}")
    async def delete_tag(self, tag_repo: TagRepo, name: str) -> None:
        """Delete a tag by name (also removes its post associations)."""
        await tag_repo.delete(name)

    @litestar.delete("/")
    async def delete_tags(self, tag_repo: TagRepo, data: TagBatchDelete) -> None:
        """Delete multiple tags."""
        await tag_repo.delete_many(data.name_list)

    @litestar.get("/groups")
    async def list_tag_group(self, tag_group_repo: TagGroupRepo) -> list[TagGroupPublic]:
        """List all tag groups."""
        groups = await tag_group_repo.list_all()
        return [TagGroupPublic.model_validate({"id": g.id, "name": g.name, "color": g.color}) for g in groups]
