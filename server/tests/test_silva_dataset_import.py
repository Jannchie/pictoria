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
    artist_dir,
    build_tag_to_group,
    copy_into_library,
    import_shard,
    lookup_metadata,
    read_shard_scores,
    safe_dir_name,
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


def _meta_row(post_id: int, **over: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": post_id,
        "rating": "g",
        "created_at": None,
        "source": "",
        "artist": "",
        "character": "",
        "copyright": "",
        "general": "",
        "meta": "",
    }
    row.update(over)
    return row


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
            _meta_row(
                1000,
                rating="s",
                created_at="2014-01-15T17:47:56.087-05:00",
                source="https://example.test/a",
                artist="alice",
                character="bob alice",
                general="solo  smile",
                meta="highres",
            ),
            _meta_row(9999),
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


def test_safe_dir_name_matches_the_ts_sanitiser() -> None:
    assert safe_dir_name("re:rin") == "re_rin"
    assert safe_dir_name('a/b\\c<d>e|f?g*h"i') == "a_b_c_d_e_f_g_h_i"
    assert safe_dir_name("trailing. ") == "trailing"
    assert safe_dir_name("ctl\x01char") == "ctl_char"
    assert safe_dir_name("...") == "_"
    assert safe_dir_name("4q_(lokcy516)") == "4q_(lokcy516)"


def test_artist_dir_takes_the_first_artist_or_the_fallback() -> None:
    assert artist_dir({"artist": "haku89 moe_maboroshi_jigen"}) == "haku89"
    assert artist_dir({"artist": "re:rin"}) == "re_rin"
    assert artist_dir({"artist": ""}) == "_no_artist"
    assert artist_dir({}) == "_no_artist"


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
    *,
    library_ids: set[str] | None = None,
    bare_rows: dict[str, tuple[str, str]] | None = None,
    dry_run: bool = False,
) -> ShardJob:
    return ShardJob(
        parquet_path=mirror["dataset"] / "scores" / "data-0007.parquet",
        images_dir=mirror["dataset"] / "images" / "0007",
        metadata_db=mirror["meta"],
        library_root=mirror["library"],
        type_to_group_id=TYPE_TO_GROUP,
        library_ids=library_ids or set(),
        bare_rows=bare_rows or {},
        dry_run=dry_run,
    )


def test_import_shard_files_posts_under_their_artist(mirror: dict[str, Path]) -> None:
    result = import_shard(_job(mirror))

    # 1000: on disk + metadata + score. 2000: on disk, no metadata → skipped.
    assert [r["fileName"] for r in result.rows] == ["1000"]
    row = result.rows[0]
    assert row["filePath"] == "danbooru/alice"
    assert row["extension"] == "webp"
    assert row["rating"] == 2
    assert row["source"] == "https://example.test/a"
    assert row["publishedAt"] == "2014-01-15T17:47:56.087-05:00"
    assert row["tags"] == {"alice": 1, "bob": 2, "solo": 4, "smile": 4, "highres": 5}
    assert row["silvaScore"] == pytest.approx(0.91, abs=1e-6)

    # Only the importable one is copied, into the artist directory; the
    # stranger never touches the library.
    copied = sorted(p.relative_to(mirror["library"]).as_posix() for p in mirror["library"].rglob("*.webp"))
    assert copied == ["danbooru/alice/1000.webp"]
    assert (mirror["library"] / "danbooru" / "alice" / "1000.webp").read_bytes() == b"RIFF-one"

    assert result.stats == {
        "scored": 2,
        "top": 1,
        "onDisk": 2,
        "duplicates": 0,
        "missingMeta": 1,
        "missingScore": 0,
        "copied": 1,
        "rows": 1,
    }


def test_import_shard_skips_posts_the_library_already_holds(mirror: dict[str, Path]) -> None:
    # 1000 is already in the library (tag importer or an earlier run): not
    # copied, not a row, counted as a duplicate.
    result = import_shard(_job(mirror, library_ids={"1000", "424242"}))
    assert result.rows == []
    assert result.stats["duplicates"] == 1
    assert result.stats["copied"] == 0
    assert not (mirror["library"] / "danbooru").exists()


def test_a_bare_row_at_our_own_path_is_repaired_not_duplicated(mirror: dict[str, Path]) -> None:
    # The reconciler registered danbooru/alice/1000.webp with no tags (a crash
    # between copy and persist): the row comes back so the upsert can fill it.
    result = import_shard(_job(mirror, bare_rows={"1000": ("danbooru/alice", "webp")}))
    assert [r["fileName"] for r in result.rows] == ["1000"]
    assert result.stats["duplicates"] == 0


def test_a_bare_row_elsewhere_is_a_duplicate(mirror: dict[str, Path]) -> None:
    # The tag importer's own bare row (original jpg under the searched tag):
    # not ours to repair, and importing would make a second file.
    result = import_shard(_job(mirror, bare_rows={"1000": ("danbooru/some_tag", "jpg")}))
    assert result.rows == []
    assert result.stats["duplicates"] == 1
    assert not (mirror["library"] / "danbooru").exists()


def test_import_shard_is_idempotent(mirror: dict[str, Path]) -> None:
    first = import_shard(_job(mirror))
    second = import_shard(_job(mirror))
    assert first.rows == second.rows
    assert second.stats["copied"] == 0


def test_import_shard_without_score_still_imports(mirror: dict[str, Path]) -> None:
    # 2000 is ok=false in the parquet; give it metadata (no artist) and it
    # imports unscored, into the no-artist directory.
    con = sqlite3.connect(mirror["meta"])
    con.execute("INSERT INTO posts VALUES (2000, 'e', NULL, NULL, '', '', '', 'solo', '')")
    con.commit()
    con.close()

    result = import_shard(_job(mirror))
    by_name = {r["fileName"]: r for r in result.rows}
    assert by_name["2000"]["silvaScore"] is None
    assert by_name["2000"]["rating"] == 4
    assert by_name["2000"]["filePath"] == "danbooru/_no_artist"
    assert by_name["2000"]["source"] == "https://danbooru.donmai.us/posts/2000"
    assert result.stats["missingScore"] == 1
    assert (mirror["library"] / "danbooru" / "_no_artist" / "2000.webp").exists()


def test_dry_run_builds_rows_without_touching_disk(mirror: dict[str, Path]) -> None:
    result = import_shard(_job(mirror, dry_run=True))
    assert [r["fileName"] for r in result.rows] == ["1000"]
    assert result.stats["copied"] == 0
    assert not (mirror["library"] / "danbooru").exists()
