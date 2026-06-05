"""Tests for ``utils.find_files_in_directory`` filtering rules."""

from __future__ import annotations

from typing import TYPE_CHECKING

from utils import find_files_in_directory

if TYPE_CHECKING:
    from pathlib import Path


def test_part_temp_files_are_not_registered(tmp_path: Path) -> None:
    sub = tmp_path / "danbooru" / "artist"
    sub.mkdir(parents=True)
    (sub / "1.jpg").write_bytes(b"ok")
    (sub / "2.jpg.part").write_bytes(b"in-flight download")

    found = find_files_in_directory(tmp_path)

    assert found == [("danbooru/artist", "1", "jpg")]


def test_top_level_dot_dirs_are_skipped(tmp_path: Path) -> None:
    hidden = tmp_path / ".pictoria"
    hidden.mkdir()
    (hidden / "x.jpg").write_bytes(b"meta")
    (tmp_path / "a.png").write_bytes(b"ok")

    assert find_files_in_directory(tmp_path) == [(".", "a", "png")]
