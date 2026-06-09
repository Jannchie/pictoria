# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "rich"]
# ///
"""批量触发本地服务从 Danbooru 拉取指定 tag 的图片。

并发上限默认 8 是经过权衡的：
- Danbooru API 限速大约 10 req/s，单 tag 仅 1~3 次 listing 请求，8 并发偶有突发可达 ~10 req/s 上限
- 下载走 CDN，不受 API 限制，但服务端每 tag 已用 16 线程，再叠加并发可能撞带宽
- 如需更激进可用 `--concurrency` 调高
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# Force UTF-8 on stdout/stderr so the rich ✓/✗ glyphs don't crash on
# Windows terminals whose default codec (e.g. cp932 / cp936) can't encode them.
for _stream in (sys.stdout, sys.stderr):
    reconfigure = getattr(_stream, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", errors="replace")

import httpx
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

LOCAL_API = "http://localhost:4777/v2/cmd/download-from-danbooru"
TAGS_FILE = Path(__file__).parent / "tags.txt"


@dataclass
class Totals:
    downloaded: int = 0
    skipped: int = 0
    failed_files: int = 0
    failed_tags: list[tuple[str, str]] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"[green]DL {self.downloaded}[/] "
            f"[yellow]SK {self.skipped}[/] "
            f"[red]ER {self.failed_files}[/]"
        )


def _record_fail(tag: str, exc: Exception, totals: Totals, console: Console, start: float) -> None:
    err = f"{type(exc).__name__}: {exc}"
    totals.failed_tags.append((tag, err))
    elapsed = time.monotonic() - start
    console.print(f"[red]✗[/] {tag} [dim]{elapsed:.1f}s[/] - {err}")


async def _post_tag(
    client: httpx.AsyncClient,
    tag: str,
    totals: Totals,
    console: Console,
    start: float,
    retries: int,
) -> None:
    # The server's /download-from-danbooru is idempotent (already-downloaded
    # posts are skipped), so retrying a timed-out/5xx tag is safe and, with a
    # finite read timeout, the only way a transient stall doesn't kill the tag.
    for attempt in range(1, retries + 1):
        try:
            resp = await client.post(LOCAL_API, params={"tags": tag})
            resp.raise_for_status()
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            if attempt >= retries:
                _record_fail(tag, exc, totals, console, start)
                return
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code < 500 or attempt >= retries:
                _record_fail(tag, exc, totals, console, start)
                return
        except Exception as exc:  # noqa: BLE001 — non-retryable, record and move on
            _record_fail(tag, exc, totals, console, start)
            return
        else:
            body = resp.text
            if not body or body in ("null", "{}"):
                msg = "empty response — server likely running old code, please restart it"
                totals.failed_tags.append((tag, msg))
                elapsed = time.monotonic() - start
                console.print(f"[yellow]?[/] {tag} [dim]{elapsed:.1f}s[/] - {msg}")
                return
            stats = resp.json()
            dl = int(stats.get("downloaded", 0))
            sk = int(stats.get("skipped", 0))
            fl = int(stats.get("failed", 0))
            totals.downloaded += dl
            totals.skipped += sk
            totals.failed_files += fl
            elapsed = time.monotonic() - start
            console.print(
                f"[green]✓[/] {tag} "
                f"([cyan]dl={dl}[/] [yellow]sk={sk}[/] [red]err={fl}[/]) "
                f"[dim]{elapsed:.1f}s[/]"
            )
            return
        # Reached only on a retryable failure with attempts left.
        backoff = 2.0 * attempt
        console.print(
            f"[yellow]…[/] {tag} [dim]retry {attempt}/{retries - 1} in {backoff:.0f}s[/]"
        )
        await asyncio.sleep(backoff)


async def download_one(
    client: httpx.AsyncClient,
    tag: str,
    sem: asyncio.Semaphore,
    progress: Progress,
    task_id: int,
    totals: Totals,
    console: Console,
    retries: int,
) -> None:
    async with sem:
        start = time.monotonic()
        try:
            await _post_tag(client, tag, totals, console, start, retries)
        finally:
            progress.update(task_id, advance=1, totals=totals.summary())


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--concurrency", type=int, default=2, help="同时处理的 tag 数（默认 2）")
    parser.add_argument("--tags-file", type=Path, default=TAGS_FILE, help="tag 列表文件路径")
    parser.add_argument(
        "--read-timeout",
        type=float,
        default=600.0,
        help="单个 tag 请求的读超时秒数（默认 600）。服务端处理期间不返回数据，"
        "所以这是单请求的总处理上限；超时后按 --retries 重试（请求幂等）",
    )
    parser.add_argument("--retries", type=int, default=3, help="单个 tag 超时/5xx 时的最大尝试次数（默认 3）")
    args = parser.parse_args()

    tags = [line.strip() for line in args.tags_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    console = Console()
    if not tags:
        console.print(f"[red]No tags found in {args.tags_file}[/]")
        return

    console.print(f"Loaded [cyan]{len(tags)}[/] tags from {args.tags_file}, concurrency=[cyan]{args.concurrency}[/]")

    sem = asyncio.Semaphore(args.concurrency)
    # A finite read timeout (was None = wait forever) so a stalled server turns
    # into a retry instead of an invisible hang. Sized to cover a legitimately
    # long import (CDN download is throttled to ~1 req/s server-side); raise
    # --read-timeout for tags with thousands of new files.
    timeout = httpx.Timeout(connect=30.0, read=args.read_timeout, write=30.0, pool=30.0)
    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency)
    totals = Totals()
    total_start = time.monotonic()

    progress = Progress(
        TextColumn("[bold]tags"),
        BarColumn(),
        MofNCompleteColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TimeElapsedColumn(),
        TextColumn("eta"),
        TimeRemainingColumn(),
        TextColumn("{task.fields[totals]}"),
        console=console,
        transient=False,
    )

    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        with progress:
            task_id = progress.add_task("tags", total=len(tags), totals=totals.summary())
            await asyncio.gather(
                *(download_one(client, tag, sem, progress, task_id, totals, console, args.retries) for tag in tags),
            )

    total_elapsed = time.monotonic() - total_start
    console.rule("[bold]Done")
    console.print(
        f"Time: [cyan]{total_elapsed:.1f}s[/]  "
        f"Tags: [green]{len(tags) - len(totals.failed_tags)} ok[/] / [red]{len(totals.failed_tags)} failed[/]  "
        f"Files: [green]{totals.downloaded} downloaded[/] / [yellow]{totals.skipped} skipped[/] / [red]{totals.failed_files} failed[/]",
    )
    if totals.failed_tags:
        console.print("[red]Failed tags:[/]")
        for tag, err in totals.failed_tags:
            console.print(f"  [red]{tag}[/]: {err}")


if __name__ == "__main__":
    asyncio.run(main())
