"""Import one shard of ``Jannchie/danbooru2026-silva-aesthetic`` from a local mirror.

The dataset is SILVA applied to all of danbooru2026: per shard a parquet of
scores (``post_id, score, raw_score, ok``) and a tar of the images scoring
``>= 0.80``, already extracted by the mirror's ``sync.py`` into
``<dataset>/images/<shard>/<post_id>.webp``. Tags, rating, source and date are
*not* in the dataset — they come from the Danbooru metadata archive
(``danbooru_metadata.db``, the ``posts`` table), looked up by post id.

This module is the fetch/parse half, same split as ``danbooru_import.py``: it
reads the parquet, the metadata SQLite (read-only — it is **not**
``pictoria.sqlite``) and copies bytes into the library, then hands back rows
in the ``posts`` table's own terms. The database write lives with the caller —
the one-shot ``scripts/import_silva_dataset.py``. The score rides along on each
row because it is the same model as the library's ``silva`` scorer (the dataset
card pins the fp16 pass at 0.0004 mean abs diff), so writing it directly saves
re-scoring every image on the GPU.
"""

from __future__ import annotations

import shutil
import sqlite3
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator
    from pathlib import Path

#: The dataset ships the images scoring at or above this; the parquet holds
#: every post. Used only to report how many of a shard's top posts are missing
#: from disk (a partial mirror), never to decide what to import — what's on
#: disk decides that.
TOP_THRESHOLD = 0.80

#: Everything in the tars is WebP (danbooru2026 re-encodes), whatever the
#: original ``file_ext`` in the metadata says.
IMAGE_EXT = "webp"

#: ``rating`` in the metadata archive is the API's one-letter form. Same map as
#: ``gallery_dl_import._BOORU_RATING``; ``utils.from_rating_to_int`` wants the
#: spelled-out words and would send all of these to 0 ("not rated").
_RATING: dict[str, int] = {"g": 1, "s": 2, "q": 3, "e": 4}

#: The ``tag_string_*`` columns, in the order the importer reads them. The
#: worker's ``typeToGroupId`` decides priority; this just names what exists.
TAG_TYPES: tuple[str, ...] = ("artist", "character", "copyright", "general", "meta")

_METADATA_COLUMNS = ("id", "rating", "created_at", "source", *(f"tag_string_{t}" for t in TAG_TYPES))

#: SQLite's default ``SQLITE_MAX_VARIABLE_NUMBER`` is 32766 on modern builds,
#: 999 on old ones; a shard's top slice is ~160 ids, so one chunk is the norm.
_LOOKUP_CHUNK = 500


@dataclass(frozen=True)
class ShardScore:
    post_id: int
    score: float


@dataclass(frozen=True)
class MetadataRow:
    post_id: int
    rating: str
    created_at: str | None
    source: str | None
    tag_strings: dict[str, str]


def read_shard_scores(parquet_path: Path) -> list[ShardScore]:
    """Every ``ok`` row of one shard's parquet.

    ``ok=false`` marks an image that failed to decode upstream; the dataset card
    says its score is meaningless, so it is dropped here rather than propagated
    as a real-looking number.
    """
    import pyarrow.parquet as pq  # noqa: PLC0415  # lazy: only the importer needs arrow

    table = pq.read_table(parquet_path, columns=["post_id", "score", "ok"])
    out: list[ShardScore] = []
    for post_id, score, ok in zip(
        table.column("post_id").to_pylist(),
        table.column("score").to_pylist(),
        table.column("ok").to_pylist(),
        strict=True,
    ):
        if ok and score is not None:
            out.append(ShardScore(int(post_id), float(score)))
    return out


def list_shard_images(images_dir: Path) -> dict[int, Path]:
    """``{post_id: path}`` for the extracted images of one shard.

    Member names are ``<post_id>.webp``; anything else in the directory is
    ignored rather than guessed at.
    """
    found: dict[int, Path] = {}
    if not images_dir.is_dir():
        return found
    for p in images_dir.iterdir():
        if p.suffix.lower() != f".{IMAGE_EXT}" or not p.stem.isdigit():
            continue
        found[int(p.stem)] = p
    return found


def _chunks(ids: list[int], size: int) -> Iterator[list[int]]:
    for i in range(0, len(ids), size):
        yield ids[i : i + size]


def lookup_metadata(db_path: Path, post_ids: Iterable[int]) -> dict[int, MetadataRow]:
    """Fetch the metadata rows for ``post_ids`` from the Danbooru archive.

    Opened read-only via URI so a typo in the path fails loudly instead of
    creating an empty database, and so this process provably never writes to
    the archive. Kept to short ``IN (...)`` reads: that database has one writer
    (its sync script) and SQLite lets a waiting writer starve a long reader.
    """
    ids = sorted(set(post_ids))
    if not ids:
        return {}
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    cols = ", ".join(_METADATA_COLUMNS)
    out: dict[int, MetadataRow] = {}
    con = sqlite3.connect(uri, uri=True)
    try:
        for chunk in _chunks(ids, _LOOKUP_CHUNK):
            marks = ",".join("?" * len(chunk))
            for row in con.execute(f"SELECT {cols} FROM posts WHERE id IN ({marks})", chunk):  # noqa: S608 — column list is a module constant
                post_id, rating, created_at, source, *tag_strings = row
                out[int(post_id)] = MetadataRow(
                    post_id=int(post_id),
                    rating=rating or "",
                    created_at=created_at,
                    source=source,
                    tag_strings={t: s or "" for t, s in zip(TAG_TYPES, tag_strings, strict=True)},
                )
    finally:
        con.close()
    return out


def build_tag_to_group(tag_strings: dict[str, str], type_to_group_id: dict[str, int]) -> dict[str, int]:
    """``{tag_name: group_id}`` from the per-type tag strings.

    Same rule as ``danbooru_import._build_tag_to_group``: ``type_to_group_id``
    is ordered by priority and ``setdefault`` keeps the first group a tag is
    seen under.
    """
    tag_to_group: dict[str, int] = {}
    for t, gid in type_to_group_id.items():
        for tag in tag_strings.get(t, "").split():
            tag_to_group.setdefault(tag, gid)
    return tag_to_group


def build_row(
    meta: MetadataRow,
    score: float | None,
    file_path_str: str,
    type_to_group_id: dict[str, int],
) -> dict[str, Any]:
    """One post in the ``posts`` table's own terms, plus its SILVA score.

    ``score`` is None for an image the parquet does not vouch for (missing or
    ``ok=false``); the row still imports and the backfill scores it later.
    """
    from utils import resolve_source  # noqa: PLC0415

    return {
        "filePath": file_path_str,
        "fileName": str(meta.post_id),
        "extension": IMAGE_EXT,
        "source": resolve_source(meta.source, f"https://danbooru.donmai.us/posts/{meta.post_id}"),
        "rating": _RATING.get(meta.rating, 0),
        "publishedAt": meta.created_at,
        "tags": build_tag_to_group(meta.tag_strings, type_to_group_id),
        "silvaScore": score,
    }


def copy_into_library(src: Path, dest: Path) -> bool:
    """Copy ``src`` to ``dest`` unless an identically sized file is already there.

    Returns True when bytes were written. Size is the whole identity check:
    the mirror is the source of truth and a partial copy from an interrupted
    run is the only realistic mismatch. Written via a temp name and renamed so
    a crash mid-copy never leaves a truncated file the sync reconciler would
    happily register as a post.
    """
    if dest.exists() and dest.stat().st_size == src.stat().st_size:
        return False
    tmp = dest.with_name(dest.name + ".part")
    shutil.copyfile(src, tmp)
    tmp.replace(dest)
    return True


@dataclass(frozen=True)
class ShardJob:
    """Everything one shard import needs."""

    parquet_path: Path
    images_dir: Path
    metadata_db: Path
    save_dir: Path
    file_path_str: str
    #: Post ids already imported *with tags* under ``file_path_str``.
    existing_ids: set[str]
    type_to_group_id: dict[str, int]
    #: Danbooru post ids the library already holds from *any other* source
    #: (``danbooru/<tag>/<id>.<ext>`` from the tag importer). Same post, same
    #: pixels modulo re-encoding — a second copy would only be a near-duplicate
    #: for the grouper to find later. Skipped like ``existing_ids`` but counted
    #: apart, because the answer to "why did only 150 of 160 import" differs.
    duplicate_ids: set[str] = field(default_factory=set)
    #: Build the rows but touch nothing on disk — for previewing a run.
    dry_run: bool = False


@dataclass
class ShardImport:
    rows: list[dict[str, Any]]
    stats: dict[str, Any]


def import_shard(job: ShardJob) -> ShardImport:
    """The whole shard, start to finish, minus the database write.

    What gets imported is what is **on disk** in the mirror: the parquet only
    supplies scores. A post already imported with tags (``existing_ids``, same
    definition as the Danbooru importer) is skipped entirely — no copy, no row.
    A post with no metadata row is skipped too: without tags, rating and date
    it would be a bare file that the sync reconciler could register just as
    well, and it is counted so a stale archive is visible. A missing score is
    only counted: the image still imports and the backfill scores it.
    """
    scores = {s.post_id: s.score for s in read_shard_scores(job.parquet_path)}
    images = list_shard_images(job.images_dir)
    duplicates = sum(1 for pid in images if str(pid) in job.duplicate_ids and str(pid) not in job.existing_ids)
    wanted = [pid for pid in sorted(images) if str(pid) not in job.existing_ids and str(pid) not in job.duplicate_ids]

    metadata = lookup_metadata(job.metadata_db, wanted)

    if not job.dry_run:
        job.save_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    copied = 0
    missing_meta = 0
    missing_score = 0
    for pid in wanted:
        meta = metadata.get(pid)
        if meta is None:
            missing_meta += 1
            continue
        score = scores.get(pid)
        if score is None:
            missing_score += 1
        if not job.dry_run and copy_into_library(images[pid], job.save_dir / f"{pid}.{IMAGE_EXT}"):
            copied += 1
        rows.append(build_row(meta, score, job.file_path_str, job.type_to_group_id))

    top = sum(1 for s in scores.values() if s >= TOP_THRESHOLD)
    return ShardImport(
        rows=rows,
        stats={
            "scored": len(scores),
            "top": top,
            "onDisk": len(images),
            "skipped": len(images) - len(wanted) - duplicates,
            "duplicates": duplicates,
            "missingMeta": missing_meta,
            "missingScore": missing_score,
            "copied": copied,
            "rows": len(rows),
        },
    )
