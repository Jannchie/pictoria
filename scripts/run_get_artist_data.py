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
import time
from dataclasses import dataclass, field
from pathlib import Path

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


async def download_one(
    client: httpx.AsyncClient,
    tag: str,
    sem: asyncio.Semaphore,
    progress: Progress,
    task_id: int,
    totals: Totals,
    console: Console,
) -> None:
    async with sem:
        start = time.monotonic()
        try:
            resp = await client.post(LOCAL_API, params={"tags": tag})
            resp.raise_for_status()
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
        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"
            totals.failed_tags.append((tag, err))
            elapsed = time.monotonic() - start
            console.print(f"[red]✗[/] {tag} [dim]{elapsed:.1f}s[/] - {err}")
        finally:
            progress.update(task_id, advance=1, totals=totals.summary())


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--concurrency", type=int, default=8, help="同时处理的 tag 数（默认 8）")
    parser.add_argument("--tags-file", type=Path, default=TAGS_FILE, help="tag 列表文件路径")
    args = parser.parse_args()

    tags = [line.strip() for line in args.tags_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    console = Console()
    if not tags:
        console.print(f"[red]No tags found in {args.tags_file}[/]")
        return

    console.print(f"Loaded [cyan]{len(tags)}[/] tags from {args.tags_file}, concurrency=[cyan]{args.concurrency}[/]")

    sem = asyncio.Semaphore(args.concurrency)
    timeout = httpx.Timeout(connect=30.0, read=None, write=30.0, pool=30.0)
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
                *(download_one(client, tag, sem, progress, task_id, totals, console) for tag in tags),
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
