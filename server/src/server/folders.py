import os
import pathlib
from typing import ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException
from pydantic import BaseModel, Field

import shared


class DirectorySummary(BaseModel):
    name: str
    path: str
    file_count: int
    children: list["DirectorySummary"] = Field(default_factory=list)


DirectorySummary.model_rebuild()


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
    tags: ClassVar[list[str]] = ["Commands"]

    @litestar.get("/", response_model=DirectorySummary, tags=["Folder"])
    async def get_folders(self) -> DirectorySummary:
        target_path = shared.target_dir
        if not target_path.exists():
            raise HTTPException(status_code=404, detail="Directory not found")
        if not target_path.is_dir():
            raise HTTPException(status_code=400, detail="Path is not a directory")

        return get_directory_summary(target_path)
