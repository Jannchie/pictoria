import concurrent.futures
import os
import random
import threading
import time
from datetime import datetime
from logging import getLogger
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel, HttpUrl

DownloadStatus = Literal["downloaded", "skipped", "failed"]

logger = getLogger("danbooru")

# Danbooru's /posts.json can be slow under load (tag-string queries, cold
# caches). The httpx default of 5s reliably times out tag pages like
# `gainoob`. Connect stays tight; reads get the long budget.
_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)

# Backoff schedule (seconds) for throttling. Caps so a single bad batch
# can't park the whole pool for hours.
_THROTTLE_BACKOFF_SECONDS: tuple[float, ...] = (5.0, 15.0, 45.0, 120.0)

# Pool-wide CDN spacing: every request waits a random interval in this
# range since the last slot. Average ≈1s, so total QPS sits around 1 req/s
# regardless of worker count. Jitter avoids a steady cadence that's trivial
# to fingerprint as a bot.
_INTERVAL_MIN = 0.5
_INTERVAL_MAX = 1.5

# Listing spacing. /posts.json is the metered API (~10 req/s for a logged-in
# user), not the CDN, so it gets its own gate: ≈5 req/s still leaves 2x
# headroom while pacing the bursts a multi-page walk under concurrent tag
# imports produces. The gate only sleeps when requests actually arrive faster
# than this — at the script's default concurrency they don't, so it costs
# nothing there and only starts shaping traffic further up.
_API_INTERVAL_MIN = 0.15
_API_INTERVAL_MAX = 0.25

# How long one call may spend being turned away by a rate limiter before it
# gives up. Kept separate from the content-retry budget — being throttled says
# nothing about whether *this* request is satisfiable, so charging it to the
# same budget lets one bad wave permanently fail a perfectly good file.
#
# Bounded by wall clock rather than by a count on purpose: the cool-down steps
# escalate 5→15→45→120, so "6 waits" is anywhere from 30s to 425s depending on
# where the escalation already stood. The number that matters to everything
# upstream — a Litestar request under the script's --read-timeout — is seconds,
# so that is what we bound. It lives next to the schedule it has to be tuned
# against, and both are constructor parameters of the gate that owns them.
_MAX_THROTTLE_SECONDS = 120.0

# The two statuses donmai.us uses to turn us away, on both the API and the CDN.
_RATE_LIMITED = (httpx.codes.FORBIDDEN, httpx.codes.TOO_MANY_REQUESTS)


class _Throttle:
    """Shared rate-limit + cool-down gate for the workers sharing one endpoint.

    Two mechanisms in one:
    * Jittered min-interval (leaky bucket): every `wait()` reserves the next
      slot at a random offset in [_INTERVAL_MIN, _INTERVAL_MAX] from the
      previous slot and sleeps until it. Total QPS is capped pool-wide and
      the cadence is irregular.
    * Reactive cooldown: on 403/429 any worker calls `report_blocked()` which
      pushes the next slot past the cooldown window; consecutive blocks
      escalate the delay, success resets it.

    The slot bookkeeping is done under a lock; the actual sleep happens
    outside the lock so a slow worker can't serialize the whole pool.
    """

    def __init__(
        self,
        interval_min: float = _INTERVAL_MIN,
        interval_max: float = _INTERVAL_MAX,
        backoff_seconds: tuple[float, ...] = _THROTTLE_BACKOFF_SECONDS,
        max_wait_seconds: float = _MAX_THROTTLE_SECONDS,
    ) -> None:
        self._lock = threading.Lock()
        self._interval_min = interval_min
        self._interval_max = interval_max
        self._backoff_seconds = backoff_seconds
        self._max_wait_seconds = max_wait_seconds
        self._next_slot = 0.0
        self._paused_until = 0.0
        self._consecutive_blocks = 0

    def patience_deadline(self) -> float:
        """When one call should stop waiting this gate out (monotonic clock).

        A deadline rather than a spend-down budget because ``report_blocked``
        piggybacks concurrent blocks onto a live cooldown and returns its
        *remaining* time — summing those returns undercounts badly (a wave of
        piggybacked calls each charge ~0 while still costing a round trip).
        Elapsed wall clock is the thing being bounded, so measure it directly.
        """
        return time.monotonic() + self._max_wait_seconds

    def out_of_patience(self, deadline: float) -> bool:
        return time.monotonic() >= deadline

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_slot, self._paused_until)
            self._next_slot = slot + random.uniform(self._interval_min, self._interval_max)  # noqa: S311
            wait_for = slot - now
        if wait_for > 0:
            time.sleep(wait_for)

    def report_blocked(self) -> float:
        with self._lock:
            now = time.monotonic()
            # Another worker already triggered the cooldown for this wave;
            # piggyback on its delay instead of escalating prematurely.
            if self._paused_until > now:
                return self._paused_until - now
            idx = min(self._consecutive_blocks, len(self._backoff_seconds) - 1)
            delay = self._backoff_seconds[idx]
            self._consecutive_blocks += 1
            self._paused_until = now + delay
            # Push the slot past the cooldown so already-queued workers
            # don't blow through the moment they wake.
            self._next_slot = max(self._next_slot, self._paused_until)
            return delay

    def report_ok(self) -> None:
        with self._lock:
            self._consecutive_blocks = 0


class Variant(BaseModel):
    type: str
    url: HttpUrl
    width: int
    height: int
    file_ext: str


class MediaAsset(BaseModel):
    id: int
    created_at: datetime
    updated_at: datetime
    sha256: str | None = None
    file_ext: str
    file_size: int
    image_width: int
    image_height: int
    duration: int | float | None = None
    status: str
    file_key: str | None = None
    is_public: bool
    pixel_hash: str
    variants: list[Variant] | None = None


class DanbooruPost(BaseModel):
    id: int
    created_at: datetime
    uploader_id: int
    score: int
    source: str | None = None
    sha256: str | None = None
    last_comment_bumped_at: datetime | None = None
    rating: str
    image_width: int
    image_height: int
    tag_string: str
    fav_count: int
    file_ext: str
    last_noted_at: datetime | None = None
    parent_id: int | None = None
    has_children: bool
    approver_id: int | None = None
    tag_count_general: int
    tag_count_artist: int
    tag_count_character: int
    tag_count_copyright: int
    file_size: int
    up_score: int
    down_score: int
    is_pending: bool
    is_flagged: bool
    is_deleted: bool
    tag_count: int
    updated_at: datetime
    is_banned: bool
    pixiv_id: int | None = None
    last_commented_at: datetime | None = None
    has_active_children: bool
    bit_flags: int
    tag_count_meta: int
    has_large: bool
    has_visible_children: bool
    media_asset: MediaAsset
    tag_string_general: str
    tag_string_character: str
    tag_string_copyright: str
    tag_string_artist: str
    tag_string_meta: str
    file_url: HttpUrl | None = None
    large_file_url: HttpUrl | None = None
    preview_file_url: HttpUrl | None = None


class DanbooruClient:
    """Danbooru API + CDN access, each behind its own rate-limit gate.

    The two endpoints are metered separately upstream — /posts.json is the
    documented ~10 req/s API, the file host is an unmetered CDN that 403s on
    sustained hammering — so they get one ``_Throttle`` each. Sharing a single
    gate coupled them in both directions; the tests named after that coupling
    pin why they must stay apart.
    """

    def __init__(self, api_key: str, user_id: str, base_url: str = "https://danbooru.donmai.us") -> None:
        self.api_key: str = api_key
        self.user_id: str = user_id
        self.base_url: str = base_url
        self.client = httpx.Client(
            base_url=base_url,
            headers={"User-Agent": "curl/8.5.0"},
            timeout=_HTTP_TIMEOUT,
        )
        self._cdn_throttle = _Throttle()
        self._api_throttle = _Throttle(_API_INTERVAL_MIN, _API_INTERVAL_MAX)

    def _get_with_retry(
        self,
        url: str,
        params: dict,
        *,
        retries: int = 3,
        backoff: float = 1.5,
    ) -> httpx.Response:
        deadline = self._api_throttle.patience_deadline()
        attempt = 0
        while attempt < retries:
            # Pace listings too. Concurrent tag imports each walk their own
            # pages, so without a gate the API sees an unbounded burst.
            self._api_throttle.wait()
            try:
                resp = self.client.get(url, params=params)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                attempt += 1
                if attempt >= retries:
                    raise
                sleep_s = backoff**attempt
                logger.warning(
                    "Danbooru GET %s timed out/failed (attempt %d/%d): %s; retrying in %.1fs",
                    url,
                    attempt,
                    retries,
                    exc,
                    sleep_s,
                )
                time.sleep(sleep_s)
                continue
            # Rate-limited: cool down on the API's own gate and retry, instead
            # of letting raise_for_status turn a transient throttle into a hard
            # tag failure. Bounded by the deadline, not by `attempt` — see
            # _MAX_THROTTLE_SECONDS. The sleep happens in the next iteration's
            # wait(), which report_blocked has already parked past the cooldown.
            if resp.status_code in _RATE_LIMITED:
                delay = self._api_throttle.report_blocked()
                logger.warning(
                    "Danbooru GET %s rate-limited (HTTP %d); cooling down %.1fs",
                    url,
                    resp.status_code,
                    delay,
                )
                if self._api_throttle.out_of_patience(deadline):
                    return resp  # let the caller's raise_for_status surface it
                continue
            self._api_throttle.report_ok()
            return resp
        # Unreachable: the loop either returns or raises.
        msg = "retry loop exited without returning"
        raise RuntimeError(msg)

    def get_post(self, post_id: int) -> DanbooruPost:
        url: str = f"posts/{post_id}.json"
        response = self._get_with_retry(url, {"api_key": self.api_key, "login": self.user_id})
        response.raise_for_status()
        return DanbooruPost(**response.json())

    def get_posts(  # noqa: PLR0913
        self,
        key: str | None = None,
        value: str | int | None = None,
        tags: str | None = None,
        limit: int = 10,
        before_id: int | None = None,
        only: str | list[str] | None = None,
    ) -> list[DanbooruPost]:
        url: str = "/posts.json"
        only_str: str | None = ",".join(only) if isinstance(only, list) else only
        all_posts: list[dict] = []

        while True:
            current_limit: int = min(limit - len(all_posts), 200)
            if current_limit <= 0:
                break

            params: dict = {
                f"{key}": value if key else None,
                "limit": current_limit,
                "api_key": self.api_key,
                "login": self.user_id,
                "page": f"b{before_id}" if before_id else None,
                "tags": tags,
                "only": only_str,
            }
            params = {k: v for k, v in params.items() if v is not None}

            response = self._get_with_retry(url, params)
            response.raise_for_status()
            logger.debug(response.url)

            posts: list[dict] = response.json()
            if not posts:
                break

            all_posts.extend(posts)
            # A short page means we've reached the tail of the result set —
            # any further `before_id` query is guaranteed to return 0 rows,
            # so skip the wasted round trip.
            if len(posts) < current_limit:
                break
            before_id = min(post["id"] for post in posts)
            if len(all_posts) >= limit:
                break
        res = []
        for post in all_posts:
            try:
                res.append(DanbooruPost(**post))
            except Exception:
                logger.exception(post)
                logger.exception("Failed to parse posts")
        return res

    def download_image(self, post: DanbooruPost, target_dir: str, retries: int = 3) -> DownloadStatus:
        if post.file_url is None:
            return "failed"
        url = str(post.file_url)
        post_id: int = post.id
        ext = post.file_ext
        file_path = Path(target_dir) / f"{post_id}.{ext}"
        if file_path.exists():
            logger.debug("File %s already exists, skipping", file_path)
            return "skipped"
        # Stream into a .part temp file and publish with an atomic rename only
        # after the byte count matches the API-reported original size. A dropped
        # connection or killed process can therefore never leave a half-written
        # file at the final path — which the exists() check above would treat
        # as done forever (the source of permanently-truncated library images).
        part_path = file_path.with_name(file_path.name + ".part")
        # Two budgets, not one. `attempt` counts attempts that actually told us
        # something about this file (a truncated body, a 5xx, a dropped
        # connection); the deadline covers the times the CDN turned us away
        # before we learned anything — see _MAX_THROTTLE_SECONDS.
        started = time.monotonic()
        deadline = self._cdn_throttle.patience_deadline()
        attempt = 0
        while attempt < retries:
            self._cdn_throttle.wait()
            outcome = self._download_attempt(post, url, part_path, attempt, retries)
            if outcome == "throttled":
                delay = self._cdn_throttle.report_blocked()
                logger.warning("Post %s rate-limited; cooling down %.1fs", post_id, delay)
                if self._cdn_throttle.out_of_patience(deadline):
                    break
                continue
            attempt += 1
            if outcome == "retry":
                continue
            if outcome == "failed":
                break
            part_path.replace(file_path)  # atomic publish of a verified file
            self._cdn_throttle.report_ok()
            logger.info("Successfully downloaded post %s", post_id)
            return "downloaded"
        part_path.unlink(missing_ok=True)  # don't leave a stale temp file behind
        logger.warning(
            "Gave up on post %s after %d content attempts and %.0fs elapsed",
            post_id,
            attempt,
            time.monotonic() - started,
        )
        return "failed"

    def _download_attempt(
        self,
        post: DanbooruPost,
        url: str,
        part_path: Path,
        attempt: int,
        retries: int,
    ) -> Literal["ok", "retry", "throttled", "failed"]:
        """One streaming GET into ``part_path``, verified against ``post.file_size``.

        Reports what happened; the caller owns the cool-down bookkeeping.
        ``throttled`` is distinct from ``retry`` — see ``_MAX_THROTTLE_SECONDS``.
        ``attempt`` is the content-attempt counter, so it deliberately does not
        move while we're only being turned away.
        """
        post_id = post.id
        try:
            logger.debug("Downloading post %s, attempt %d/%d", post_id, attempt + 1, retries)
            with self.client.stream("GET", url) as response:
                status = response.status_code
                # 403/429 = CDN rate-limit. Park the whole pool, retry.
                if status in _RATE_LIMITED:
                    response.read()
                    return "throttled"
                # Other 4xx (404/410/...) = permanent, don't waste retries.
                if httpx.codes.BAD_REQUEST <= status < httpx.codes.INTERNAL_SERVER_ERROR:
                    logger.warning("Post %s HTTP %d; not retryable", post_id, status)
                    return "failed"
                response.raise_for_status()
                written = 0
                with part_path.open("wb") as f:
                    for chunk in response.iter_bytes():
                        f.write(chunk)
                        written += len(chunk)
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "Post %s server error %d on attempt %d/%d",
                post_id,
                exc.response.status_code,
                attempt + 1,
                retries,
            )
            return "retry"
        except httpx.RequestError as exc:
            logger.warning(
                "Post %s network error on attempt %d/%d: %s",
                post_id,
                attempt + 1,
                retries,
                exc,
            )
            return "retry"
        # End-to-end truncation check: file_url serves the original file, whose
        # exact byte size the API reports in `file_size`. A short body that
        # slipped past the transport layer (e.g. a connection torn down at a
        # chunk boundary) is caught here.
        if post.file_size and written != post.file_size:
            logger.warning(
                "Post %s truncated: got %d of %d bytes (attempt %d/%d); retrying",
                post_id,
                written,
                post.file_size,
                attempt + 1,
                retries,
            )
            return "retry"
        return "ok"

    def download_posts(
        self,
        posts: list[DanbooruPost],
        target_dir: os.PathLike,
        n_worker: int = 16,
    ) -> dict[DownloadStatus, int]:
        target_dir = Path(target_dir)
        target_dir.mkdir(exist_ok=True, parents=True)
        logger.info("Download started!")
        stats: dict[DownloadStatus, int] = {"downloaded": 0, "skipped": 0, "failed": 0}
        with concurrent.futures.ThreadPoolExecutor(max_workers=n_worker) as executor:
            futures = []
            for post in posts:
                logger.debug("Downloading post %s", post.id)
                future = executor.submit(self.download_image, post, str(target_dir))
                futures.append(future)
            for fut in concurrent.futures.as_completed(futures):
                try:
                    stats[fut.result()] += 1
                except Exception:
                    logger.exception("Download worker raised")
                    stats["failed"] += 1
        logger.info("Download completed: %s", stats)
        return stats
