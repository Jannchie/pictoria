import asyncio
import os
import pathlib
from typing import ClassVar

import litestar
from litestar import Controller
from pydantic import BaseModel, Field

import shared
from db.queries.post_query import FolderScoreAgg, PostQueryService
from server.exceptions import DirectoryNotFoundError, PathNotADirectoryError


class DirectorySummary(BaseModel):
    name: str
    path: str
    file_count: int  # files on disk under this dir (recursive), unchanged
    # Aggregates over the posts (DB) under this dir, recursive. None = no data.
    post_count: int = 0
    silva_avg: float | None = None  # raw 0~1 mean; frontend ×10 for display
    score_avg: float | None = None  # manual star mean over scored posts only
    rating_avg: float | None = None  # G/S/Q/E (1~4) mean over all posts
    scored_ratio: float | None = None  # scored posts / total posts
    children: list["DirectorySummary"] = Field(default_factory=list)


DirectorySummary.model_rebuild()


def attach_folder_stats(summary: DirectorySummary, aggregates: dict[str, FolderScoreAgg]) -> FolderScoreAgg:
    """Fill the recursive score averages on ``summary`` and its subtree, in place.

    Pure: walks the already-built directory tree, adds each node's direct
    aggregate (``aggregates[node.path]``) to the roll-up of its children, writes
    the resulting averages onto the node, and returns the subtree's summed
    ``FolderScoreAgg`` so the parent can keep rolling up. ``file_path`` matches
    the tree ``path`` exactly (root ``'.'`` ↔ root posts' ``file_path='.'``).
    """
    total = FolderScoreAgg()
    direct = aggregates.get(summary.path)
    if direct is not None:
        total.add(direct)
    for child in summary.children:
        total.add(attach_folder_stats(child, aggregates))

    summary.post_count = total.posts
    summary.silva_avg = total.silva_total / total.silva_n if total.silva_n else None
    summary.score_avg = total.score_total / total.scored if total.scored else None
    summary.rating_avg = total.rating_total / total.posts if total.posts else None
    summary.scored_ratio = total.scored / total.posts if total.posts else None
    return total


def get_directory_summary(path_data: str | pathlib.Path) -> DirectorySummary:
    full_path = pathlib.Path(path_data)
    relative_path = full_path.relative_to(shared.target_dir)
    summary = DirectorySummary(
        name=relative_path.name,
        path=relative_path.as_posix(),
        file_count=0,
        children=[],
    )

    ignore_dirs = shared.pictoria_dir
    with os.scandir(shared.target_dir / path_data) as entries:
        for entry in entries:
            if entry.name == ignore_dirs.name:
                continue
            if entry.is_dir():
                subtree = get_directory_summary(entry.path)
                summary.children.append(subtree)
                summary.file_count += subtree.file_count
            else:
                summary.file_count += 1

    return summary


class FoldersController(Controller):
    path = "/folders"
    tags: ClassVar[list[str]] = ["Commands"]  # type: ignore

    @litestar.get("/", response_model=DirectorySummary, tags=["Folder"])
    async def get_folders(self, post_query: PostQueryService) -> DirectorySummary:
        target_path = shared.target_dir
        if not target_path.exists():
            raise DirectoryNotFoundError
        if not target_path.is_dir():
            raise PathNotADirectoryError

        summary = await asyncio.to_thread(get_directory_summary, target_path)
        aggregates = await post_query.folder_score_aggregates()
        attach_folder_stats(summary, aggregates)
        return summary
