"""Fetch a creator/tag page's metadata via gallery-dl, download images, persist.

gallery-dl is used purely as a multi-site metadata extractor: `gallery-dl -j`
dumps every entry's metadata to stdout (nothing written to disk). We filter to
images, dedupe against the DB, download the new ones ourselves (httpx, into
target_dir/<category>/<creator>/), then persist posts + tags reusing the
danbooru_import transaction skeleton. See
docs/superpowers/specs/2026-06-03-gallery-dl-creator-fetch-design.md.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any

from services.danbooru_import import SUPPORTED_IMAGE_EXTS
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
