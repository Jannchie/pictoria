"""Transport-level tests for ``DanbooruClient``: downloads and pagination.

The downloader streams into a ``.part`` temp file, verifies the byte count
against the API-reported ``file_size``, and only then atomically renames to
the final path. These tests pin the three behaviours that keep truncated
files out of the library: short bodies are retried, exhausted retries leave
nothing behind, and a retry that succeeds publishes the complete file.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import TYPE_CHECKING

import httpx
import pytest

from danbooru import DanbooruClient, _Throttle

if TYPE_CHECKING:
    from pathlib import Path

FULL_BODY = b"x" * 1024


@pytest.fixture(autouse=True)
def _quiet_danbooru_logger(caplog: pytest.LogCaptureFixture) -> None:
    """Silence the per-row parse failures the paging tests deliberately provoke.

    ``get_posts`` logs a traceback per unparseable row; at 200 rows a page the
    formatting alone dominates the test's runtime.
    """
    caplog.set_level(logging.CRITICAL, logger="danbooru")


def _make_client(handler) -> DanbooruClient:
    client = DanbooruClient(api_key="k", user_id="u")
    # base_url matters for the listing tests: get_posts issues the relative
    # "/posts.json". Download tests pass absolute CDN urls and ignore it.
    client.client = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="https://danbooru.example",
    )
    # No pacing, and a cool-down schedule scaled down from the real
    # 5/15/45/120s so the rate-limit cases don't pay it in wall clock. The
    # backoff has to stay non-zero: patience is measured in elapsed seconds, so
    # free cooldowns would never run it out.
    knobs = {"interval_min": 0, "interval_max": 0, "backoff_seconds": (0.05,), "max_wait_seconds": 0.2}
    client._cdn_throttle = _Throttle(**knobs)
    client._api_throttle = _Throttle(**knobs)
    return client


def _make_post() -> SimpleNamespace:
    return SimpleNamespace(
        id=123,
        file_url="https://cdn.example/123.jpg",
        file_ext="jpg",
        file_size=len(FULL_BODY),
    )


def test_complete_download_is_published_atomically(tmp_path: Path) -> None:
    client = _make_client(lambda _req: httpx.Response(200, content=FULL_BODY))

    assert client.download_image(_make_post(), str(tmp_path)) == "downloaded"

    final = tmp_path / "123.jpg"
    assert final.read_bytes() == FULL_BODY
    assert not (tmp_path / "123.jpg.part").exists()


def test_truncated_download_fails_and_leaves_no_file(tmp_path: Path) -> None:
    # Body shorter than the API-reported file_size on every attempt.
    client = _make_client(lambda _req: httpx.Response(200, content=FULL_BODY[:100]))

    assert client.download_image(_make_post(), str(tmp_path)) == "failed"

    # Nothing at the final path (so the next import retries it) and no
    # stale .part temp file either.
    assert list(tmp_path.iterdir()) == []


def _paging_client(page_size: int = 200) -> tuple[DanbooruClient, dict]:
    """A client whose /posts.json always returns a full page of unparseable rows.

    The rows deliberately fail ``DanbooruPost`` validation — these tests are
    about how many round trips pagination makes, not about parsing — so
    ``get_posts`` returns [] while the request counter tells the real story.
    """
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=[{"id": i} for i in range(page_size)])

    return _make_client(handler), calls


def test_truncated_then_complete_download_recovers(tmp_path: Path) -> None:
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        body = FULL_BODY[:100] if calls["n"] == 1 else FULL_BODY
        return httpx.Response(200, content=body)

    client = _make_client(handler)

    assert client.download_image(_make_post(), str(tmp_path)) == "downloaded"
    assert calls["n"] == 2
    assert (tmp_path / "123.jpg").read_bytes() == FULL_BODY


def test_rate_limits_do_not_consume_the_content_retry_budget(tmp_path: Path) -> None:
    # Two 403s, then two truncations, then the real bytes. With one shared
    # budget of 3 this file died on the CDN's mood; the throttle waits are now
    # charged separately, so all three content attempts remain available.
    script = [403, 403, "short", "short", "full"]
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        step = script[calls["n"]]
        calls["n"] += 1
        if step == 403:
            return httpx.Response(403, content=b"")
        return httpx.Response(200, content=FULL_BODY[:100] if step == "short" else FULL_BODY)

    client = _make_client(handler)

    assert client.download_image(_make_post(), str(tmp_path)) == "downloaded"
    assert calls["n"] == len(script)
    assert (tmp_path / "123.jpg").read_bytes() == FULL_BODY


# The exact number of 403s a call absorbs isn't pinned, and measurably varies
# run to run (10-12 for the download loop on the author's machine): wait() can
# return a hair before _paused_until, so the next report_blocked() piggybacks
# on the still-live cooldown instead of escalating. These tests assert the
# property that actually matters — patience runs out — with a ceiling loose
# enough to survive that jitter and tight enough to catch a runaway loop.
_LOOSE_WAIT_CEILING = 40


def test_endless_rate_limiting_still_gives_up(tmp_path: Path) -> None:
    # Without a bound, a CDN that 403s forever parks a worker forever.
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(403, content=b"")

    client = _make_client(handler)

    assert client.download_image(_make_post(), str(tmp_path)) == "failed"
    assert 1 < calls["n"] < _LOOSE_WAIT_CEILING
    assert list(tmp_path.iterdir()) == []


def test_a_rate_limited_listing_also_gets_the_separate_budget() -> None:
    # The same rule as download_image: a 429 says nothing about whether the
    # listing is satisfiable, so it must not eat the 3 content retries. Before,
    # 3 rate-limited attempts hard-failed the whole tag; now the seconds budget
    # decides, which is why the call outlives `retries`.
    calls = {"n": 0}

    def handler(_req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, content=b"")

    client = _make_client(handler)

    # Budget exhausted → the 429 is handed back for raise_for_status to surface.
    assert client._get_with_retry("/posts.json", {}, retries=3).status_code == 429  # noqa: PLR2004
    assert 3 < calls["n"] < _LOOSE_WAIT_CEILING


def test_listing_success_no_longer_resets_the_cdn_backoff() -> None:
    # The bug: both paths shared one _Throttle, so every successful listing
    # called report_ok() and wiped the download pool's escalating cool-down.
    # Under concurrent tag imports listings succeed constantly, so a genuinely
    # throttled CDN never got past the first step and retried forever.
    client, _calls = _paging_client()
    client._cdn_throttle.report_blocked()  # CDN is one step into its backoff

    client.get_posts(tags="artist", limit=200)  # a successful listing

    assert client._cdn_throttle._consecutive_blocks == 1  # not reset to 0


def test_a_rate_limited_listing_does_not_freeze_the_download_pool() -> None:
    # The mirror-image coupling: the API being throttled used to push out the
    # shared next-slot, parking every in-flight download for the same window.
    client = _make_client(lambda _req: httpx.Response(200))

    client._api_throttle.report_blocked()

    assert client._cdn_throttle._paused_until == 0.0
