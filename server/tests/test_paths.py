"""``paths.py`` -- the Python half of ``apps/api/src/paths.ts``.

Every relative override is anchored at the repo root, never at the cwd: the
worker and every script run from ``server/`` while the API runs elsewhere, so a
cwd-relative answer is two processes silently opening two different files. The
tests ``chdir`` somewhere unrelated to prove the cwd plays no part.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

import paths
from paths import DEFAULT_TARGET_DIR, REPO_ROOT, db_path, pictoria_dir, target_dir, tasks_db_path, thumbnails_root

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for var in ("PICTORIA_TARGET_DIR", "DB_PATH", "TASKS_DB_PATH"):
        monkeypatch.delenv(var, raising=False)
    cwd = tmp_path / "elsewhere"
    cwd.mkdir()
    monkeypatch.chdir(cwd)


def test_repo_root_is_the_workspace_root() -> None:
    assert (REPO_ROOT / "pnpm-workspace.yaml").is_file()
    assert paths.__file__ is not None
    assert (REPO_ROOT / "server" / "src" / "paths.py").samefile(paths.__file__)


def test_target_dir_defaults_under_the_repo_root() -> None:
    assert target_dir() == (REPO_ROOT / DEFAULT_TARGET_DIR).resolve()


def test_relative_target_dir_is_anchored_at_the_repo_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PICTORIA_TARGET_DIR", "some/library")
    assert target_dir() == (REPO_ROOT / "some" / "library").resolve()


def test_absolute_target_dir_is_taken_as_is(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PICTORIA_TARGET_DIR", str(tmp_path / "lib"))
    assert target_dir() == (tmp_path / "lib").resolve()


def test_layout_under_the_default_root() -> None:
    assert pictoria_dir() == target_dir() / ".pictoria"
    assert thumbnails_root() == target_dir() / ".pictoria" / "thumbnails"


def test_layout_under_an_explicit_root(tmp_path: Path) -> None:
    # The worker's ``--target_dir`` overrides the env var, so it passes its root.
    assert pictoria_dir(tmp_path) == tmp_path / ".pictoria"
    assert thumbnails_root(tmp_path) == tmp_path / ".pictoria" / "thumbnails"


def test_db_path_defaults_into_the_library() -> None:
    assert db_path() == target_dir() / ".pictoria" / "pictoria.sqlite"


def test_db_path_follows_the_target_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PICTORIA_TARGET_DIR", str(tmp_path))
    assert db_path() == tmp_path.resolve() / ".pictoria" / "pictoria.sqlite"


def test_relative_db_path_is_anchored_at_the_repo_root_not_the_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DB_PATH", "copies/test.sqlite")
    assert db_path() == (REPO_ROOT / "copies" / "test.sqlite").resolve()
    assert not db_path().is_relative_to(tmp_path)


def test_absolute_db_path_is_taken_as_is(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DB_PATH", str(tmp_path / "x.sqlite"))
    assert db_path() == (tmp_path / "x.sqlite").resolve()


def test_tasks_db_defaults_under_the_given_root(tmp_path: Path) -> None:
    assert tasks_db_path(tmp_path) == tmp_path / ".pictoria" / "tasks.sqlite"


def test_relative_tasks_db_is_anchored_at_the_repo_root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("TASKS_DB_PATH", "queues/tasks.sqlite")
    assert tasks_db_path(tmp_path) == (REPO_ROOT / "queues" / "tasks.sqlite").resolve()
