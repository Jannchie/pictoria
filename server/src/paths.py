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
    """The image library root. Mirrors ``paths.ts``'s ``targetDir()`` exactly.

    Both processes have to land on the same directory or the failure is silent:
    the API submits to one ``tasks.sqlite`` while the worker polls another, so
    every ``tasks.call`` just runs out its timeout with nothing logged. A
    mismatched *root* is worse -- ``_resolve_inside`` rejects the payload paths
    as escaping it, which is a *per-item* failure, so TS writes every post into
    ``post_process_failures``, a permanent blacklist that fixing the config does
    not undo. That is why the env var, the default and the repo-root anchor are
    duplicated from ``paths.ts`` rather than the worker taking a required flag.
    """
    return (REPO_ROOT / os.environ.get("PICTORIA_TARGET_DIR", DEFAULT_TARGET_DIR)).resolve()


def pictoria_dir(root: Path | None = None) -> Path:
    """The library's private directory. Mirrors ``paths.ts``'s ``pictoriaDir()``.

    ``root`` defaults to :func:`target_dir`; the worker passes the root it was
    started with, because its ``--target_dir`` flag can override the env var.
    """
    return (root if root is not None else target_dir()) / ".pictoria"


def thumbnails_root(root: Path | None = None) -> Path:
    """Where thumbnails live. Mirrors ``paths.ts``'s ``thumbnailsDir()``.

    Only the scripts read this. The worker never derives a thumbnail path: TS
    computes every one (``thumbnailPathFor``) and sends it in the payload.
    """
    return pictoria_dir(root) / "thumbnails"


def _anchored(override: str) -> Path:
    """A path from an env var, with a relative one anchored at the repo root.

    Never at the cwd: the worker's cwd is ``server/`` (``pnpm dev:worker`` cd's
    there) while the API's is the repo root, so cwd-relative resolution is
    exactly the split-brain described in :func:`target_dir` -- two processes
    silently opening two different files. An absolute override is unaffected
    (``REPO_ROOT / absolute`` is the absolute path).
    """
    return (REPO_ROOT / override).resolve()


def db_path() -> Path:
    """The library database. Mirrors ``paths.ts``'s ``dbPath()``, ``DB_PATH`` included.

    The override lives *here* rather than at the call sites so that this
    function is the whole rule — anyone running against a copy or a test library
    sets one env var and every script follows, instead of half of them silently
    reporting numbers about the default library.

    A relative ``DB_PATH`` is anchored at the repo root -- the same rule as
    ``TASKS_DB_PATH`` and ``PICTORIA_TARGET_DIR`` -- never at the cwd, which is
    ``server/`` for every script and would read a different file than the API
    writes. (⚠️ ``paths.ts``'s ``dbPath()`` still hands a relative override to
    better-sqlite3 raw, i.e. cwd-relative -- ``apps/api`` under ``pnpm
    --filter``; use an absolute ``DB_PATH`` until that side anchors it too.)
    """
    override = os.environ.get("DB_PATH")
    return _anchored(override) if override else pictoria_dir() / "pictoria.sqlite"


def tasks_db_path(root: Path) -> Path:
    """cairnq's queue database. Mirrors ``paths.ts``'s ``tasksDbPath()``.

    The ``TASKS_DB_PATH`` override lives *here* rather than at the call site so
    that this function is the whole rule -- on the TS side it is one expression,
    and splitting default from override across two places is how the next reader
    gets a different answer than the code does. A relative override is anchored
    at the repo root (:func:`_anchored`).

    ``root`` is a parameter rather than a call to ``target_dir()`` because the
    worker accepts a ``--target_dir`` flag that overrides the env var.
    """
    override = os.environ.get("TASKS_DB_PATH")
    return _anchored(override) if override else pictoria_dir(root) / "tasks.sqlite"
