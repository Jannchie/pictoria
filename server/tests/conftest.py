"""Shared pytest fixtures for the backend data-access test suite.

The suite pins the *current* behaviour of the data-access layer (a
characterization / golden-master baseline) so the upcoming repository
refactor can be proven behaviour-preserving. Everything runs against a real
on-disk SQLite file (not ``:memory:`` — the repo layer hands out a cursor that
``asyncio.to_thread`` workers reuse across threads, and ``:memory:`` is not
shared across the thread-local connections ``DB`` opens).

All seed data uses fixed timestamps and float32-exact LAB values so snapshots
compare byte-for-byte deterministically.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest
import sqlite_vec

from db.connection import DB
from db.migrator import run_migrations
from db.queries.post_query import PostQueryService
from db.repositories.posts import PostRepo
from db.repositories.scores import ScoreRepo
from db.repositories.tags import TagRepo

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

# Fixed timestamps keep golden-master snapshots deterministic.
TS = "2026-01-01 00:00:00+00:00"
TS_PUB = "2026-02-02 12:00:00+00:00"


def _insert_post(
    cur: sqlite3.Cursor,
    *,
    post_id: int,
    file_path: str,
    file_name: str,
    extension: str,
    rating: int = 0,
    score: int = 0,
    lab: tuple[float, float, float] | None = None,
    published_at: str | None = None,
) -> None:
    dominant = sqlite_vec.serialize_float32(list(lab)) if lab is not None else None
    cur.execute(
        """
        INSERT INTO posts(
            id, file_path, file_name, extension, width, height,
            published_at, score, rating, description, meta, sha256, size,
            source, caption, dominant_color, arthash,
            created_at, updated_at, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, '', '', ?, ?, ?, ?, ?)
        """,
        [
            post_id, file_path, file_name, extension, 100 + post_id, 200,
            published_at, score, rating, f"sha{post_id}", 1000 * post_id,
            dominant, f"hash{post_id}", TS, TS, TS,
        ],
    )


def _seed(cur: sqlite3.Cursor) -> None:
    # ── tag groups & tags ────────────────────────────────────────────
    cur.executescript(
        f"""
        INSERT INTO tag_groups(id, name, color, created_at, updated_at)
        VALUES (1, 'artist', '#ff0000', '{TS}', '{TS}'),
               (2, 'general', '#00ff00', '{TS}', '{TS}');

        INSERT INTO tags(name, group_id, created_at, updated_at) VALUES
            ('artist_a', 1, '{TS}', '{TS}'),
            ('tag_general', 2, '{TS}', '{TS}'),
            ('no_group_tag', NULL, '{TS}', '{TS}');
        """,
    )

    # ── posts (cover extensions / ratings / scores / lab present-absent)
    _insert_post(cur, post_id=1, file_path="photos", file_name="a", extension="jpg",
                 rating=2, score=3, lab=(50.0, 10.0, -5.0), published_at=TS_PUB)
    _insert_post(cur, post_id=2, file_path="photos", file_name="b", extension="png",
                 rating=0, score=0, lab=None)
    _insert_post(cur, post_id=3, file_path="photos/sub", file_name="c", extension="jpg",
                 rating=1, score=5, lab=(25.0, -8.0, 4.0))
    _insert_post(cur, post_id=4, file_path="art", file_name="d", extension="webp",
                 rating=3, score=0, lab=None)
    _insert_post(cur, post_id=5, file_path="art", file_name="e", extension="jpg",
                 rating=2, score=3, lab=(75.0, 0.5, 0.25))

    # ── post_has_tag (auto flag + grouped/ungrouped + no-tag post) ────
    cur.executescript(
        """
        INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES
            (1, 'artist_a', 1),
            (1, 'tag_general', 0),
            (2, 'no_group_tag', 0),
            (4, 'tag_general', 1),
            (5, 'artist_a', 0);
        """,
    )

    # ── post_has_color (present on 1/3/5, absent on 2/4) ──────────────
    cur.executescript(
        """
        INSERT INTO post_has_color(post_id, "order", color) VALUES
            (1, 0, 16711680), (1, 1, 65280),
            (3, 0, 255),
            (5, 0, 16777215), (5, 1, 0), (5, 2, 128);
        """,
    )

    # ── waifu scores: A/C/D/E buckets + post 2 UNSCORED ───────────────
    cur.executescript(
        """
        INSERT INTO post_waifu_scores(post_id, score) VALUES
            (1, 8.5), (3, 5.0), (4, 1.0), (5, 3.5);
        """,
    )

    # ── aesthetic scores (silva), only on a subset ────────────────────
    # silva (raw [0,1] scale) on posts 4/5; posts 1/2/3 have none.
    cur.executescript(
        """
        INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES
            (4, 'silva', 0.4),
            (5, 'silva', 0.9);
        """,
    )


@pytest.fixture
def db(tmp_path: Path) -> Iterator[DB]:
    database = DB(tmp_path / "test.sqlite")
    run_migrations(database.raw, MIGRATIONS_DIR)
    _seed(database.cursor())
    yield database
    database.close()


@pytest.fixture
def post_repo(db: DB) -> PostRepo:
    return PostRepo(db.cursor())


@pytest.fixture
def query(db: DB) -> PostQueryService:
    return PostQueryService(db.cursor())


@pytest.fixture
def tag_repo(db: DB) -> TagRepo:
    return TagRepo(db.cursor())


@pytest.fixture
def score_repo(db: DB) -> ScoreRepo:
    return ScoreRepo(db.cursor())
