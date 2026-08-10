"""Presign S3 GETs through minio-py, for the parity harness.

Reads ``{"amzDate": "20260102T030405Z", "objects": [...]}`` on stdin and writes
the presigned URLs on stdout. The date is pinned by the caller because a SigV4
signature covers the timestamp — without pinning it there is nothing to compare
character-for-character against.

This is the *reference* the hand-written TS signer
(``apps/api/src/s3.ts``) has to match, and like ``worker_direct.py`` it exists
only for that. Nothing else may import it.
"""

from __future__ import annotations

import datetime
import json
import os
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dotenv import load_dotenv  # noqa: E402
from minio import Minio  # noqa: E402
from minio.signer import presign_v4  # noqa: E402


def main() -> None:
    # Windows defaults stdio to the ANSI codepage, which turns a non-ASCII object
    # name into lone surrogates and blows up inside minio's quote().
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    req = json.load(sys.stdin)
    when = datetime.datetime.strptime(req["amzDate"], "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.UTC)

    client = Minio(
        os.environ["S3_ENDPOINT"],
        access_key=os.environ["S3_ACCESS_KEY"],
        secret_key=os.environ["S3_SECRET_KEY"],
        secure=True,
    )
    bucket = os.environ.get("S3_BUCKET", "pictoria")
    base = os.environ.get("S3_BASE_DIR", "collections").strip()
    region = client._get_region(bucket)  # noqa: SLF001  # no public accessor

    out = []
    for name in req["objects"]:
        url = client._base_url.build(  # noqa: SLF001  # ditto
            method="GET",
            region=region,
            bucket_name=bucket,
            object_name=f"{base}/{name}",
        )
        signed = presign_v4(
            method="GET",
            url=url,
            region=region,
            credentials=client._provider.retrieve(),  # noqa: SLF001
            date=when,
            expires=604800,
        )
        out.append(urllib.parse.urlunsplit(signed))
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
