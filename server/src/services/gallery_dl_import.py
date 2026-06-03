"""Fetch a creator/tag page's metadata via gallery-dl, download images, persist.

gallery-dl is used purely as a multi-site metadata extractor: `gallery-dl -j`
dumps every entry's metadata to stdout (nothing written to disk). We filter to
images, dedupe against the DB, download the new ones ourselves (httpx, into
target_dir/<category>/<creator>/), then persist posts + tags reusing the
danbooru_import transaction skeleton. See
docs/superpowers/specs/2026-06-03-gallery-dl-creator-fetch-design.md.
"""

from __future__ import annotations

import concurrent.futures
import json
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from services.danbooru_import import (
    SUPPORTED_IMAGE_EXTS,
    _insert_tags_tx,
    _run_with_retry,
)
from utils import from_rating_to_int, logger, resolve_source

# gallery-dl message type for "a downloadable file" (url + metadata). Confirmed
# against real yande.re -j output: [3, "<url>", {meta}]; type 2 (Directory) is
# ignored so each file yields exactly one entry.
_MSG_URL = 3


def run_gallery_dl_json(url: str, *, config_path: str | None = None) -> list[tuple[str, dict[str, Any]]]:
    """Run `gallery-dl -j <url>` and return [(download_url, metadata), ...].

    Never raises: a non-zero exit (CF 403, bad URL, AuthRequired) or unparseable
    stdout logs a warning and yields [] so the driver can continue to the next
    creator. Invoked as ``python -m gallery_dl`` (current interpreter) so it
    doesn't depend on a console-script being on PATH.
    """
    cmd = [sys.executable, "-m", "gallery_dl", "-j"]
    if config_path:
        cmd += ["--config", config_path]
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)  # noqa: S603
    except FileNotFoundError:
        logger.error("gallery-dl not found; is it installed in this environment?")
        return []
    if proc.returncode != 0:
        logger.warning(f"gallery-dl failed for {url} (exit {proc.returncode}): {proc.stderr.strip()[:200]}")
        return []
    try:
        messages = json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning(f"gallery-dl produced unparseable JSON for {url}: {exc}")
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    for msg in messages:
        if isinstance(msg, list) and len(msg) >= 3 and msg[0] == _MSG_URL:
            out.append((msg[1], msg[2]))
    return out


# Booru tag-field name (in gallery-dl metadata) -> our canonical group name.
# Confirmed in Task 3: gelbooru/danbooru expose these per-category fields;
# moebooru (yande.re/konachan) only has a flat `tags`, handled by the fallback
# in parse_entry (everything lands in "general").
_BOORU_TAG_FIELDS: dict[str, str] = {
    "tags_artist": "artist",
    "tags_character": "character",
    "tags_copyright": "copyright",
    "tags_general": "general",
    "tags_metadata": "meta",
}

# Booru single-letter rating -> Pictoria rating int. Danbooru uses g/s/q/e
# (general/sensitive/questionable/explicit); moebooru uses s/q/e where "s"=safe,
# mapped to sensitive here (a harmless over-tag — rating isn't load-bearing).
# Full-word ratings fall through to from_rating_to_int.
_BOORU_RATING: dict[str, int] = {"g": 1, "s": 2, "q": 3, "e": 4}


def _rating_to_int(raw: Any) -> int:
    if not isinstance(raw, str) or not raw:
        return 0
    if len(raw) == 1:
        return _BOORU_RATING.get(raw.lower(), 0)
    return from_rating_to_int(raw)


@dataclass
class GalleryDLItem:
    download_url: str
    file_name: str                                # posts.file_name (no extension)
    extension: str                                # lowercase, no dot
    source: str                                   # resolved (registered or fallback)
    category: str                                 # gallery-dl category (e.g. yandere, kemono)
    creator: str                                  # search tag / username -> directory
    rating: int
    published_at: str | None
    tags_by_category: dict[str, list[str]] = field(default_factory=dict)


def parse_entry(download_url: str, meta: dict, *, fallback_url: str) -> GalleryDLItem | None:
    """Normalise one (url, metadata) into a GalleryDLItem; non-image -> None."""
    ext = str(meta.get("extension", "")).lower().lstrip(".")
    if ext not in SUPPORTED_IMAGE_EXTS:
        return None
    file_name = str(meta.get("id") or meta.get("filename") or "").strip()
    if not file_name:
        return None

    tags_by_category: dict[str, list[str]] = {}
    for meta_field, group in _BOORU_TAG_FIELDS.items():
        raw = meta.get(meta_field)
        if raw:
            tags_by_category[group] = str(raw).split()
    # moebooru fallback: only a flat `tags` string, no per-category fields.
    if not tags_by_category:
        flat = meta.get("tags")
        if flat:
            tags_by_category["general"] = str(flat).split()

    creator = str(
        meta.get("search_tags") or meta.get("username") or meta.get("user") or "misc",
    ).strip() or "misc"

    return GalleryDLItem(
        download_url=download_url,
        file_name=file_name,
        extension=ext,
        source=resolve_source(meta.get("source"), fallback_url),
        category=str(meta.get("category", "misc")),
        creator=creator,
        rating=_rating_to_int(meta.get("rating")),
        published_at=meta.get("date") or meta.get("created_at"),
        tags_by_category=tags_by_category,
    )


def build_tag_to_group(item: GalleryDLItem, type_to_group_id: dict[str, int]) -> dict[str, int]:
    """Flatten the item's per-category tags into {tag_name: group_id}.

    Tags whose category isn't in type_to_group_id are dropped (shouldn't happen
    with the five canonical groups). Kemono items carry no categorised tags, so
    this returns {} and auto-tagging fills them in later.
    """
    out: dict[str, int] = {}
    for group_name, names in item.tags_by_category.items():
        gid = type_to_group_id.get(group_name)
        if gid is None:
            continue
        for name in names:
            out.setdefault(name, gid)
    return out


# Mirror danbooru's downloader: a curl-ish UA gets past naive UA blocks.
_DL_HEADERS = {"User-Agent": "curl/8.5.0"}


def download_items(
    items: Sequence[GalleryDLItem],
    save_dir: Path,
    *,
    headers: dict[str, str] | None = None,
    n_worker: int = 16,
) -> dict[str, int]:
    """Download each item's direct URL into save_dir/<file_name>.<extension>.

    headers lets Kemono pass cookies/UA (from gallery-dl.conf); defaults to a
    curl UA (enough for Booru CDNs). Returns {"downloaded": N, "failed": M}.
    """
    save_dir.mkdir(parents=True, exist_ok=True)
    hdrs = {**_DL_HEADERS, **(headers or {})}
    stats = {"downloaded": 0, "failed": 0}

    def _one(item: GalleryDLItem) -> None:
        target = save_dir / f"{item.file_name}.{item.extension}"
        resp = httpx.get(item.download_url, headers=hdrs, follow_redirects=True, timeout=60.0)
        resp.raise_for_status()
        target.write_bytes(resp.content)

    with concurrent.futures.ThreadPoolExecutor(max_workers=n_worker) as ex:
        futures = [ex.submit(_one, it) for it in items]
        for fut in concurrent.futures.as_completed(futures):
            try:
                fut.result()
                stats["downloaded"] += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"gallery-dl download failed: {exc}")
                stats["failed"] += 1
    return stats


def _persist_gallery_items(
    db: Any,
    file_path: str,
    items: Sequence[GalleryDLItem],
    type_to_group_id: dict[str, int],
) -> None:
    """Persist items + tags in two transactions, mirroring danbooru_import."""
    if not items:
        return
    tag_maps = [build_tag_to_group(it, type_to_group_id) for it in items]
    cur = db.cursor()
    try:
        all_tags: dict[str, int] = {}
        for tm in tag_maps:
            for name, gid in tm.items():
                all_tags.setdefault(name, gid)
        if all_tags:
            _run_with_retry(cur, "tags", lambda: _insert_tags_tx(cur, all_tags))
        _run_with_retry(cur, "posts", lambda: _insert_gallery_posts_tx(cur, file_path, items, tag_maps))
    finally:
        cur.close()


def _insert_gallery_posts_tx(
    cur: Any,
    file_path: str,
    items: Sequence[GalleryDLItem],
    tag_maps: Sequence[dict[str, int]],
) -> None:
    cur.execute("BEGIN")
    post_tag_pairs: list[tuple[int, dict[str, int]]] = []
    for item, tag_map in zip(items, tag_maps, strict=True):
        cur.execute(
            """
            INSERT INTO posts(file_path, file_name, extension, source, rating, published_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (file_path, file_name, extension)
            DO UPDATE SET source = excluded.source,
                          published_at = excluded.published_at,
                          updated_at = CURRENT_TIMESTAMP
            RETURNING id
            """,
            [file_path, item.file_name, item.extension, item.source, item.rating, item.published_at],
        )
        row = cur.fetchone()
        if row:
            post_tag_pairs.append((int(row[0]), tag_map))
    post_tag_rows = [(pid, name) for pid, tm in post_tag_pairs for name in tm]
    if post_tag_rows:
        cur.executemany(
            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) "
            "ON CONFLICT DO NOTHING",
            post_tag_rows,
        )
    cur.execute("COMMIT")
