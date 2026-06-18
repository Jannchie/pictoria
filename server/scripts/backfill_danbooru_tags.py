"""Backfill missing manual Danbooru tags for posts under ``danbooru/*``.

Why this exists
---------------
Some images land in the library *before* the Danbooru importer ever processes
them: a file is dropped on disk, filesystem reconciliation
(``PostRepo.create_paths``) inserts a bare ``posts`` row (path only, empty
``source``, no tags), and the wdtagger backfill later attaches *automatic*
(``is_auto=1``) tags. Such a post has tags but no *manual* Danbooru tags, and
because its ``file_name`` already "exists" the importer's dedup used to skip it
forever. ``import_danbooru_posts`` now keys dedup on manual-tag presence, but
that only helps on the *next* import run — this script repairs the existing
backlog.

How it repairs
--------------
The post's ``file_name`` IS the Danbooru post id (that's how the importer names
files). So instead of searching by the directory name (which is a sanitised tag
string and may not even be a real Danbooru tag — these images aren't guaranteed
to come from Danbooru at all), we look each id up directly via
``id:a,b,c`` batch queries. A post is repaired ONLY when Danbooru actually
returns that exact id. Anything we can't resolve — non-numeric file names,
deleted posts, ids Danbooru doesn't know — is left untouched and counted.

Safety
------
Dry-run by default: it reports what it *would* do and writes nothing. Pass
``--apply`` to actually write. Writes go in per-batch IMMEDIATE transactions
with a busy timeout so a running server (WAL) just serialises with us.

Usage (from server/):
    uv run python scripts/backfill_danbooru_tags.py            # dry-run, whole library
    uv run python scripts/backfill_danbooru_tags.py --apply    # write
    uv run python scripts/backfill_danbooru_tags.py --only "danbooru/dino_(dinoartforame)"
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from collections import defaultdict

from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

load_dotenv(".env")

from danbooru import DanbooruClient  # noqa: E402
from server.commands import ensure_canonical_tag_groups_sync  # noqa: E402
from services.danbooru_import import SUPPORTED_IMAGE_EXTS, _build_tag_to_group  # noqa: E402
from utils import from_rating_to_int, resolve_source  # noqa: E402

DB_DEFAULT = os.path.abspath(
    os.path.join("illustration", "images", ".pictoria", "pictoria.sqlite"),
)
_BATCH = 100  # ids per `id:a,b,c` query (danbooru returns <=200/page)


def _bare_posts(cur: sqlite3.Cursor, only: str | None) -> list[tuple[int, str, str, int]]:
    """(post_id, file_path, file_name, size) for danbooru posts lacking any manual tag."""
    sql = (
        "SELECT p.id, p.file_path, p.file_name, p.size FROM posts p "
        "WHERE p.file_path LIKE 'danbooru/%' "
        "AND NOT EXISTS (SELECT 1 FROM post_has_tag t "
        "                WHERE t.post_id = p.id AND t.is_auto = 0)"
    )
    params: list[str] = []
    if only:
        sql += " AND p.file_path = ?"
        params.append(only)
    cur.execute(sql, params)
    return [(int(r[0]), r[1], r[2], int(r[3]) if r[3] is not None else 0) for r in cur.fetchall()]


def _chunks(items: list[str], n: int):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry-run)")
    ap.add_argument("--db", default=DB_DEFAULT, help="path to pictoria.sqlite")
    ap.add_argument("--only", default=None, help="restrict to one file_path, e.g. 'danbooru/foo'")
    ap.add_argument("--batch-size", type=int, default=_BATCH)
    args = ap.parse_args()

    db = sqlite3.connect(args.db, timeout=30)
    db.execute("PRAGMA busy_timeout = 30000")
    db.execute("PRAGMA foreign_keys = ON")
    cur = db.cursor()
    groups = ensure_canonical_tag_groups_sync(cur)
    db.commit()

    bare = _bare_posts(cur, args.only)
    # file_name (= danbooru id) -> [(local post_id, local size), ...]; one id can
    # sit in several directories if the same Danbooru post was downloaded under
    # multiple tags. Carrying the local size lets us require a byte-exact match
    # against danbooru below — so a non-danbooru file (e.g. a pixiv image) whose
    # numeric name coincidentally collides with a real danbooru id never gets
    # that post's tags grafted onto it.
    id_to_posts: dict[str, list[tuple[int, int]]] = defaultdict(list)
    non_numeric = 0
    for post_id, _fp, file_name, size in bare:
        if file_name.isdigit():
            id_to_posts[file_name].append((post_id, size))
        else:
            non_numeric += 1

    wanted_ids = sorted(id_to_posts, key=int)
    print(f"DB: {len(bare)} danbooru posts without manual tags")
    print(f"    {len(wanted_ids)} distinct numeric ids to look up, {non_numeric} non-numeric (skipped)")
    if not wanted_ids:
        print("Nothing to do.")
        return

    client = DanbooruClient(
        os.environ.get("DANBOORU_API_KEY", ""),
        os.environ.get("DANBOORU_USER_NAME", ""),
    )

    resolved: dict[str, object] = {}  # danbooru id -> DanbooruPost
    for batch in _chunks(wanted_ids, args.batch_size):
        posts = client.get_posts(tags="id:" + ",".join(batch), limit=200)
        for p in posts:
            resolved[str(p.id)] = p
        print(f"  looked up {len(batch)} ids -> {len(posts)} returned (running total {len(resolved)})")

    not_found = [i for i in wanted_ids if i not in resolved]

    tag_inserts: set[tuple[str, int]] = set()      # (name, group_id)
    link_inserts: list[tuple[int, str]] = []       # (post_id, tag_name)
    post_updates: list[tuple[str, int, str, int]] = []  # (source, rating, published_at, post_id)
    skipped_no_url = 0
    skipped_size_mismatch: list[tuple[str, int, int]] = []  # (id, local_size, danbooru_size)

    for did, post in resolved.items():
        ext = (getattr(post, "file_ext", "") or "").lower()
        if not getattr(post, "file_url", None) or ext not in SUPPORTED_IMAGE_EXTS:
            skipped_no_url += 1
            continue
        tag_map = _build_tag_to_group(post, groups)
        src = resolve_source(post.source, f"https://danbooru.donmai.us/posts/{post.id}")
        rating = from_rating_to_int(post.rating)
        d_size = getattr(post, "file_size", 0) or 0
        for local_id, local_size in id_to_posts[did]:
            # Byte-exact identity guard: only graft danbooru's tags onto a local
            # file that IS danbooru's file. A 0 local size means we never hashed
            # it (no size on record) — treat as unverifiable and skip.
            if not local_size or local_size != d_size:
                skipped_size_mismatch.append((did, local_size, d_size))
                continue
            for name, gid in tag_map.items():
                tag_inserts.add((name, gid))
                link_inserts.append((local_id, name))
            post_updates.append((src, rating, str(post.created_at), local_id))

    print("\n=== plan ===")
    print(f"  posts to repair      : {len(post_updates)}")
    print(f"  tag rows to ensure   : {len(tag_inserts)}")
    print(f"  post_has_tag links   : {len(link_inserts)}")
    print(f"  ids API didn't return: {len(not_found)} (deleted / unknown / not danbooru)")
    print(f"  resolved-but-no-image: {skipped_no_url}")
    print(f"  SKIPPED size mismatch: {len(skipped_size_mismatch)} (numeric name != that danbooru file)")
    if not_found[:10]:
        print(f"  sample not-found ids : {not_found[:10]}")
    if skipped_size_mismatch[:10]:
        print(f"  sample size mismatch : {skipped_size_mismatch[:10]}")

    if not args.apply:
        print("\nDRY-RUN -- nothing written. Re-run with --apply to commit.")
        return

    def _commit_chunked(rows: list, sql: str, chunk: int = 4000) -> None:
        # Many short IMMEDIATE transactions instead of one giant one: each holds
        # the write lock only briefly, so a live server's imports/sync interleave
        # politely instead of blocking on (or being blocked by) a multi-100k-row
        # commit.
        for i in range(0, len(rows), chunk):
            cur.execute("BEGIN IMMEDIATE")
            try:
                cur.executemany(sql, rows[i : i + chunk])
                cur.execute("COMMIT")
            except Exception:
                cur.execute("ROLLBACK")
                raise

    # Tags first — they're the FK parent of post_has_tag.tag_name. Small set, one tx.
    cur.execute("BEGIN IMMEDIATE")
    try:
        cur.executemany(
            "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
            sorted(tag_inserts),
        )
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise

    # Fill the empty source/rating/published_at the bare rows never got.
    _commit_chunked(
        post_updates,
        "UPDATE posts SET source = ?, rating = ?, published_at = ?, "
        "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    # post_has_tag AFTER INSERT trigger keeps tags.post_count in sync.
    _commit_chunked(
        link_inserts,
        "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
    )

    print(f"\nApplied: repaired {len(post_updates)} posts, {len(link_inserts)} tag links written.")


if __name__ == "__main__":
    main()
