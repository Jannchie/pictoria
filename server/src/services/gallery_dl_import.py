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
from typing import Any

from utils import logger

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
