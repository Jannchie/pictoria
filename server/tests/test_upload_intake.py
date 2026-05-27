"""Unit tests for the upload workflow lifted out of ``PostController.upload_file``.

Path resolution and the file/url guard used to be buried in the HTTP handler;
now they're a plain object that can be exercised without a request.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from server.exceptions import InvalidUploadError
from services.intake import UploadIntake


def test_resolve_path_url_only_uses_last_segment() -> None:
    assert UploadIntake._resolve_path(None, "https://i.example/a/b/z.jpg", None) == "z.jpg"


def test_resolve_path_explicit_path_wins_when_no_file() -> None:
    assert UploadIntake._resolve_path(None, "https://i.example/a/b/z.jpg", "folder/name.jpg") == "folder/name.jpg"


def test_resolve_path_file_without_dir_uses_filename() -> None:
    file = SimpleNamespace(filename="pic.png")
    assert UploadIntake._resolve_path(file, None, None) == "pic.png"


def test_resolve_path_file_under_explicit_dir_is_joined() -> None:
    file = SimpleNamespace(filename="pic.png")
    assert UploadIntake._resolve_path(file, None, "albums") == "albums/pic.png"


async def test_store_requires_file_or_url() -> None:
    intake = UploadIntake(None, None, None)  # repos never touched on this path
    with pytest.raises(InvalidUploadError):
        await intake.store(file=None, url=None, path=None, source=None)
