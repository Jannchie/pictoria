"""``services.silva_dataset_import`` against a tiny synthetic mirror.

One shard: a parquet with three scored posts (one ``ok=false``), two images on
disk, and a metadata archive that knows about one of them plus a stranger.
Everything the real run does — parquet, read-only SQLite, copy-into-library —
happens here on tmp_path, so the assertions are about behaviour, not mocks.
"""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from services.silva_dataset_import import (
    ShardJob,
    build_tag_to_group,
    copy_into_library,
    import_shard,
    lookup_metadata,
    read_shard_scores,
)

if TYPE_CHECKING:
    from pathlib import Path

TYPE_TO_GROUP = {"artist": 1, "character": 2, "copyright": 3, "general": 4, "meta": 5}


def _write_parquet(path: Path, rows: list[tuple[int, float, bool]]) -> None:
    table = pa.table(
        {
            "post_id": pa.array([r[0] for r in rows], pa.int64()),
            "score": pa.array([r[1] for r in rows], pa.float32()),
            "raw_score": pa.array([r[1] for r in rows], pa.float32()),
            "ok": pa.array([r[2] for r in rows], pa.bool_()),
        },
    )
    pq.write_table(table, path)


def _write_metadata(path: Path, rows: list[dict[str, object]]) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, rating TEXT, created_at TEXT, source TEXT, "
        "tag_string_artist TEXT, tag_string_character TEXT, tag_string_copyright TEXT, "
        "tag_string_general TEXT, tag_string_meta TEXT)",
    )
    for r in rows:
        con.execute(
            "INSERT INTO posts VALUES (:id, :rating, :created_at, :source, :artist, :character, :copyright, :general, :meta)",
            r,
        )
    con.commit()
    con.close()


@pytest.fixture
def mirror(tmp_path: Path) -> dict[str, Path]:
    dataset = tmp_path / "dataset"
    (dataset / "scores").mkdir(parents=True)
    (dataset / "images" / "0007").mkdir(parents=True)
    _write_parquet(
        dataset / "scores" / "data-0007.parquet",
        [(1000, 0.91, True), (2000, 0.85, False), (3000, 0.12, True)],
    )
    (dataset / "images" / "0007" / "1000.webp").write_bytes(b"RIFF-one")
    (dataset / "images" / "0007" / "2000.webp").write_bytes(b"RIFF-two")
    (dataset / "images" / "0007" / "notes.txt").write_text("ignored")

    meta = tmp_path / "meta.db"
    _write_metadata(
        meta,
        [
            {
                "id": 1000,
                "rating": "s",
                "created_at": "2014-01-15T17:47:56.087-05:00",
                "source": "https://example.test/a",
                "artist": "alice",
                "character": "bob alice",
                "copyright": "",
                "general": "solo  smile",
                "meta": "highres",
            },
            {
                "id": 9999,
                "rating": "g",
                "created_at": None,
                "source": "",
                "artist": "",
                "character": "",
                "copyright": "",
                "general": "",
                "meta": "",
            },
        ],
    )
    return {"dataset": dataset, "meta": meta, "library": tmp_path / "library"}


def test_read_shard_scores_drops_not_ok(mirror: dict[str, Path]) -> None:
    got = read_shard_scores(mirror["dataset"] / "scores" / "data-0007.parquet")
    assert [(s.post_id, round(s.score, 2)) for s in got] == [(1000, 0.91), (3000, 0.12)]


def test_lookup_metadata_is_read_only_and_keyed(mirror: dict[str, Path]) -> None:
    rows = lookup_metadata(mirror["meta"], [1000, 4242])
    assert set(rows) == {1000}
    assert rows[1000].rating == "s"
    assert rows[1000].tag_strings["character"] == "bob alice"


def test_lookup_metadata_refuses_a_missing_archive(tmp_path: Path) -> None:
    # mode=ro must not conjure an empty database at a mistyped path.
    with pytest.raises(sqlite3.OperationalError):
        lookup_metadata(tmp_path / "nope.db", [1])
    assert not (tmp_path / "nope.db").exists()


def test_build_tag_to_group_keeps_highest_priority_group() -> None:
    strings = {"artist": "alice", "character": "bob alice", "general": "solo"}
    assert build_tag_to_group(strings, TYPE_TO_GROUP) == {"alice": 1, "bob": 2, "solo": 4}


def test_copy_into_library_skips_same_size_and_leaves_no_part_file(tmp_path: Path) -> None:
    src = tmp_path / "src.webp"
    src.write_bytes(b"abc")
    dest = tmp_path / "out" / "1.webp"
    dest.parent.mkdir()
    assert copy_into_library(src, dest) is True
    assert dest.read_bytes() == b"abc"
    assert copy_into_library(src, dest) is False
    assert list(dest.parent.iterdir()) == [dest]


def _job(
    mirror: dict[str, Path],
    existing: set[str] | None = None,
    *,
    duplicates: set[str] | None = None,
    dry_run: bool = False,
) -> ShardJob:
    return ShardJob(
        parquet_path=mirror["dataset"] / "scores" / "data-0007.parquet",
        images_dir=mirror["dataset"] / "images" / "0007",
        metadata_db=mirror["meta"],
        save_dir=mirror["library"] / "danbooru2026" / "0007",
        file_path_str="danbooru2026/0007",
        existing_ids=existing or set(),
        type_to_group_id=TYPE_TO_GROUP,
        duplicate_ids=duplicates or set(),
        dry_run=dry_run,
    )


def test_import_shard_returns_rows_for_images_with_metadata(mirror: dict[str, Path]) -> None:
    result = import_shard(_job(mirror))

    # 1000: on disk + metadata + score. 2000: on disk, no metadata → skipped.
    assert [r["fileName"] for r in result.rows] == ["1000"]
    row = result.rows[0]
    assert row["filePath"] == "danbooru2026/0007"
    assert row["extension"] == "webp"
    assert row["rating"] == 2
    assert row["source"] == "https://example.test/a"
    assert row["publishedAt"] == "2014-01-15T17:47:56.087-05:00"
    assert row["tags"] == {"alice": 1, "bob": 2, "solo": 4, "smile": 4, "highres": 5}
    assert row["silvaScore"] == pytest.approx(0.91, abs=1e-6)

    # Only the importable one is copied; the stranger never touches the library.
    copied = sorted(p.name for p in (mirror["library"] / "danbooru2026" / "0007").iterdir())
    assert copied == ["1000.webp"]
    assert (mirror["library"] / "danbooru2026" / "0007" / "1000.webp").read_bytes() == b"RIFF-one"

    assert result.stats == {
        "scored": 2,
        "top": 1,
        "onDisk": 2,
        "skipped": 0,
        "duplicates": 0,
        "missingMeta": 1,
        "missingScore": 0,
        "copied": 1,
        "rows": 1,
    }


def test_import_shard_skips_already_imported_ids(mirror: dict[str, Path]) -> None:
    result = import_shard(_job(mirror, existing={"1000"}))
    assert result.rows == []
    assert result.stats["skipped"] == 1
    assert result.stats["copied"] == 0
    assert not (mirror["library"] / "danbooru2026" / "0007" / "1000.webp").exists()


def test_import_shard_is_idempotent(mirror: dict[str, Path]) -> None:
    first = import_shard(_job(mirror))
    second = import_shard(_job(mirror))
    assert first.rows == second.rows
    assert second.stats["copied"] == 0


def test_import_shard_without_score_still_imports(mirror: dict[str, Path]) -> None:
    # 2000 is ok=false in the parquet; give it metadata and it imports unscored.
    con = sqlite3.connect(mirror["meta"])
    con.execute("INSERT INTO posts VALUES (2000, 'e', NULL, NULL, '', '', '', 'solo', '')")
    con.commit()
    con.close()

    result = import_shard(_job(mirror))
    by_name = {r["fileName"]: r for r in result.rows}
    assert by_name["2000"]["silvaScore"] is None
    assert by_name["2000"]["rating"] == 4
    assert by_name["2000"]["source"] == "https://danbooru.donmai.us/posts/2000"
    assert result.stats["missingScore"] == 1


def test_dry_run_builds_rows_without_touching_disk(mirror: dict[str, Path]) -> None:
    result = import_shard(_job(mirror, dry_run=True))
    assert [r["fileName"] for r in result.rows] == ["1000"]
    assert result.stats["copied"] == 0
    assert not (mirror["library"] / "danbooru2026").exists()


def test_import_shard_skips_posts_the_library_already_holds_elsewhere(mirror: dict[str, Path]) -> None:
    # 1000 is already in the library as danbooru/<tag>/1000.jpg: not copied, not
    # a row, and counted as a duplicate rather than as "already imported here".
    result = import_shard(_job(mirror, duplicates={"1000", "424242"}))
    assert result.rows == []
    assert result.stats["duplicates"] == 1
    assert result.stats["skipped"] == 0
    assert result.stats["copied"] == 0
    assert not (mirror["library"] / "danbooru2026" / "0007" / "1000.webp").exists()


def test_existing_here_wins_over_duplicate_elsewhere(mirror: dict[str, Path]) -> None:
    result = import_shard(_job(mirror, existing={"1000"}, duplicates={"1000"}))
    assert result.stats["skipped"] == 1
    assert result.stats["duplicates"] == 0
