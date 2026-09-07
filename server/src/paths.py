"""Where things live, on the Python side — the twin of ``apps/api/src/paths.ts``.

``paths.ts``'s file header explains why this matters: the default target dir was
once written out in four places, and the API and the worker resolving to
*different* directories is silent — the API submits to one ``tasks.sqlite``
while the worker polls another, so every ``tasks.call`` just runs out its
timeout with nothing logged.

That duplication is unavoidable across two languages, but it should be exactly
one function per concept **per language**. Everything on this side — the worker
entry point and every script under ``server/scripts/`` — resolves paths through
here, so the TS↔Python twin has only one Python half to keep in sync.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Repo root, derived from this file's location rather than the cwd: the cwd
#: depends on how you launched (``pnpm dev:worker`` cd's into ``server/``), so a
#: relative config value would mean two different directories to the two halves.
#: This file is ``server/src/paths.py``, hence two parents up.
REPO_ROOT = Path(__file__).resolve().parents[2]

#: Must stay byte-identical to ``paths.ts``'s fallback in ``targetDir()``.
DEFAULT_TARGET_DIR = "server/illustration/images"


def target_dir() -> Path:
    """The image library root. Mirrors ``paths.ts``'s ``targetDir()`` exactly."""
    return (REPO_ROOT / os.environ.get("PICTORIA_TARGET_DIR", DEFAULT_TARGET_DIR)).resolve()


def pictoria_dir() -> Path:
    """The library's private directory. Mirrors ``paths.ts``'s ``pictoriaDir()``."""
    return target_dir() / ".pictoria"


def thumbnails_root() -> Path:
    """Where thumbnails live. Mirrors ``paths.ts``'s ``thumbnailsDir()``."""
    return pictoria_dir() / "thumbnails"


def db_path() -> Path:
    """The library database. Mirrors ``paths.ts``'s ``dbPath()``, ``DB_PATH`` included.

    The override lives *here* rather than at the call sites so that this
    function is the whole rule — anyone running against a copy or a test library
    sets one env var and every script follows, instead of half of them silently
    reporting numbers about the default library.
    """
    override = os.environ.get("DB_PATH")
    return Path(override).resolve() if override else pictoria_dir() / "pictoria.sqlite"


def tasks_db_path(root: Path) -> Path:
    """cairnq's queue database. Mirrors ``paths.ts``'s ``tasksDbPath()``.

    The ``TASKS_DB_PATH`` override lives *here* rather than at the call site so
    that this function is the whole rule -- on the TS side it is one expression,
    and splitting default from override across two places is how the next reader
    gets a different answer than the code does.

    A relative override is anchored at the *repo root*, same as
    ``PICTORIA_TARGET_DIR`` -- never at the cwd. The worker's cwd is ``server/``
    (``pnpm dev:worker`` cd's there) while the API's is the repo root, so
    cwd-relative resolution is exactly the split-brain described in
    ``target_dir()``: two processes silently opening two different queue files.

    ``root`` is a parameter rather than a call to ``target_dir()`` because the
    worker accepts a ``--target_dir`` flag that overrides the env var.
    """
    override = os.environ.get("TASKS_DB_PATH")
    return (REPO_ROOT / override).resolve() if override else root / ".pictoria" / "tasks.sqlite"
