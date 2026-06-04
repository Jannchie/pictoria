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

# Backoff schedule (seconds) for CDN throttling. Caps so a single bad batch
# can't park the whole pool for hours.
_THROTTLE_BACKOFF_SECONDS: tuple[float, ...] = (5.0, 15.0, 45.0, 120.0)

# Pool-wide CDN spacing: every request waits a random interval in this
# range since the last slot. Average ≈1s, so total QPS sits around 1 req/s
# regardless of worker count. Jitter avoids a steady cadence that's trivial
# to fingerprint as a bot.
_INTERVAL_MIN = 0.5
_INTERVAL_MAX = 1.5


class _Throttle:
    """Shared rate-limit + cool-down gate for all CDN workers on one client.

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
    ) -> None:
        self._lock = threading.Lock()
        self._interval_min = interval_min
        self._interval_max = interval_max
        self._next_slot = 0.0
        self._paused_until = 0.0
        self._consecutive_blocks = 0

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
            idx = min(self._consecutive_blocks, len(_THROTTLE_BACKOFF_SECONDS) - 1)
            delay = _THROTTLE_BACKOFF_SECONDS[idx]
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
    def __init__(self, api_key: str, user_id: str, base_url: str = "https://danbooru.donmai.us") -> None:
        self.api_key: str = api_key
        self.user_id: str = user_id
        self.base_url: str = base_url
        self.client = httpx.Client(
            base_url=base_url,
            headers={"User-Agent": "curl/8.5.0"},
            timeout=_HTTP_TIMEOUT,
        )
        self._throttle = _Throttle()

    def _get_with_retry(
        self,
        url: str,
        params: dict,
        *,
        retries: int = 3,
        backoff: float = 1.5,
    ) -> httpx.Response:
        for attempt in range(1, retries + 1):
            try:
                return self.client.get(url, params=params)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt == retries:
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
        for attempt in range(retries):
            self._throttle.wait()
            try:
                logger.debug("Downloading post %s, attempt %d/%d", post.id, attempt + 1, retries)
                with self.client.stream("GET", url) as response:
                    status = response.status_code
                    # 403/429 = CDN rate-limit. Park the whole pool, retry.
                    if status in (403, 429):
                        response.read()
                        delay = self._throttle.report_blocked()
                        logger.warning(
                            "Post %s rate-limited (HTTP %d); cooling down %.1fs (attempt %d/%d)",
                            post_id,
                            status,
                            delay,
                            attempt + 1,
                            retries,
                        )
                        continue
                    # Other 4xx (404/410/...) = permanent, don't waste retries.
                    if httpx.codes.BAD_REQUEST <= status < httpx.codes.INTERNAL_SERVER_ERROR:
                        logger.warning("Post %s HTTP %d; not retryable", post_id, status)
                        return "failed"
                    response.raise_for_status()
                    with file_path.open("wb") as f:
                        for chunk in response.iter_bytes():
                            f.write(chunk)
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "Post %s server error %d on attempt %d/%d",
                    post_id,
                    exc.response.status_code,
                    attempt + 1,
                    retries,
                )
                continue
            except httpx.RequestError as exc:
                logger.warning(
                    "Post %s network error on attempt %d/%d: %s",
                    post_id,
                    attempt + 1,
                    retries,
                    exc,
                )
                continue
            else:
                self._throttle.report_ok()
                logger.info("Successfully downloaded post %s", post_id)
                return "downloaded"
        logger.warning("All %d attempts to download post %s failed", retries, post_id)
        return "failed"

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
