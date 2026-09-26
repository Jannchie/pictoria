# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "rich"]
# ///
"""批量触发本地服务从 Danbooru 拉取指定 tag 的图片。

并发默认压到 2 是经过权衡的：
- 服务端每个 tag 已用 16 线程下载，且 CDN 侧是 pool-wide ≈1 req/s 的节流，再叠并发只是加长排队
- listing 走的是另一条 ≈5 req/s 的 API 节流；默认并发下请求本来就来得比这慢，闸门几乎不生效
- 如需更激进可用 `--concurrency` 调高

重复运行的成本由两层挡掉：
- 本层：``--skip-recent``（默认 3 天）读 state 文件，跳过近期已成功的 tag，连请求都不发
- 服务端：listing 翻到「整页都已导入」就停止翻页，所以真正发出去的 tag 通常只花 1 次 API 请求

两者都以「可能漏掉 Danbooru 事后补标的旧图」换速度。``--full`` 同时绕过冷却并让服务端
走完整分页，用来定期补齐。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
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
    TaskID,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

LOCAL_API = "http://localhost:4777/v2/cmd/download-from-danbooru"
TAGS_FILE = Path(__file__).parent / "tags.txt"
STATE_FILE = Path(__file__).parent / ".run_get_artist_data_state.jsonl"
#: 整份重写的旧格式；存在就读一次作为底，不再写入。
LEGACY_STATE_FILE = Path(__file__).parent / ".run_get_artist_data_state.json"

# 读超时不会取消服务端的工作——那个 import 仍在跑同一个 tag。隔 2 秒重发只会让
# 两个 import 抢同一个目录，并把服务端 pool-wide 的 CDN 配额劈成两半，于是双方
# 都更慢、更容易再次超时。等久一点让原请求自己跑完，重试多半直接命中「已导入」
# 而秒回。
_TIMEOUT_BACKOFF = 60.0
# 网络抖动 / 5xx 是另一回事：服务端那边没有留下在跑的工作，快速重试即可。
_ERROR_BACKOFF = 2.0


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


class TagState:
    """每个 tag 上次成功导入的时间，用来跳过冷却期内的 tag。

    只记成功：失败的 tag 不写入，所以下次运行必定重试。每次 ``mark_ok`` 往
    jsonl 末尾追加一行 ``{"tag", "at"}`` 并 flush，所以哪怕被 SIGKILL 也只丢掉
    正在跑的那个 tag。被截断的半行会和下一次追加的行粘成一行坏行，读取时跳过——
    代价只是这两个 tag 下一轮重跑，不会让整份状态失效。同一个 tag 出现多行时
    后写的赢。

    曾经是每次整份重写 JSON：O(n²) 的写放大，tag 池涨到几万个后一轮光重写
    状态就是几十 GB。旧格式的 ``.json`` 若还在，启动时读一次作为底，之后只写
    jsonl。追加的行会越积越多（每轮一行一个 tag），加载时合并；真嫌大了删掉
    文件，代价只是下一轮不跳过任何 tag。
    """

    def __init__(self, path: Path, legacy_path: Path | None = None) -> None:
        self.path = path
        self._last_ok: dict[str, str] = {}
        if legacy_path is not None and legacy_path.exists():
            try:
                raw = json.loads(legacy_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                raw = {}  # 坏掉的旧状态等价于「没有状态」
            loaded = raw.get("last_ok") if isinstance(raw, dict) else None
            if isinstance(loaded, dict):
                self._last_ok = {k: v for k, v in loaded.items() if isinstance(v, str)}
        if path.exists():
            with path.open(encoding="utf-8") as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue  # 被中断的半行
                    if isinstance(entry, dict) and isinstance(entry.get("tag"), str) and isinstance(entry.get("at"), str):
                        self._last_ok[entry["tag"]] = entry["at"]

    def is_fresh(self, tag: str, now: datetime, max_age_days: float) -> bool:
        """这个 tag 是否还在冷却期内。无记录或时间戳坏掉都算「不新鲜」，即照常跑。"""
        stamp = self._last_ok.get(tag)
        if stamp is None:
            return False
        try:
            when = datetime.fromisoformat(stamp)
        except ValueError:
            return False
        return (now - when).total_seconds() / 86400.0 < max_age_days

    def mark_ok(self, tag: str, now: datetime) -> None:
        stamp = now.isoformat(timespec="seconds")
        self._last_ok[tag] = stamp
        with self.path.open("a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps({"tag": tag, "at": stamp}, ensure_ascii=False) + "\n")


@dataclass
class Job:
    """一次运行内所有 tag 共享的东西。"""

    client: httpx.AsyncClient
    console: Console
    totals: Totals
    state: TagState
    retries: int
    full_scan: bool


def _record_fail(tag: str, exc: Exception, totals: Totals, console: Console, start: float) -> None:
    err = f"{type(exc).__name__}: {exc}"
    totals.failed_tags.append((tag, err))
    elapsed = time.monotonic() - start
    console.print(f"[red]✗[/] {tag} [dim]{elapsed:.1f}s[/] - {err}")


def _retry_backoff(exc: Exception, attempt: int) -> float | None:
    """重试前该等多久；None = 这个异常不值得重试。

    超时单独一档：读超时不会取消服务端的工作（见 ``_TIMEOUT_BACKOFF``），其余
    可重试的错误服务端没留下在跑的活，快速重试即可。
    """
    if isinstance(exc, httpx.TimeoutException):
        return _TIMEOUT_BACKOFF
    if isinstance(exc, httpx.HTTPStatusError):
        return _ERROR_BACKOFF * attempt if exc.response.status_code >= 500 else None
    if isinstance(exc, httpx.TransportError):
        return _ERROR_BACKOFF * attempt
    return None


async def _post_tag(job: Job, tag: str, start: float) -> None:
    totals, console, retries = job.totals, job.console, job.retries
    params = {"tags": tag, "full_scan": job.full_scan}
    # The server's /download-from-danbooru is idempotent (already-downloaded
    # posts are skipped), so retrying a timed-out/5xx tag is safe and, with a
    # finite read timeout, the only way a transient stall doesn't kill the tag.
    for attempt in range(1, retries + 1):
        try:
            resp = await job.client.post(LOCAL_API, params=params)
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001 — classified by _retry_backoff
            backoff = _retry_backoff(exc, attempt)
            if backoff is None or attempt >= retries:
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
            # 只有整个 tag 干净跑完才进冷却；有文件失败就不记，下次照常重试。
            if fl == 0:
                job.state.mark_ok(tag, datetime.now(tz=UTC))
            elapsed = time.monotonic() - start
            console.print(
                f"[green]✓[/] {tag} "
                f"([cyan]dl={dl}[/] [yellow]sk={sk}[/] [red]err={fl}[/]) "
                f"[dim]{elapsed:.1f}s[/]"
            )
            return
        # Reached only on a retryable failure with attempts left.
        console.print(
            f"[yellow]…[/] {tag} [dim]retry {attempt}/{retries - 1} in {backoff:.0f}s[/]"
        )
        await asyncio.sleep(backoff)


async def download_one(
    job: Job,
    tag: str,
    sem: asyncio.Semaphore,
    progress: Progress,
    task_id: TaskID,
) -> None:
    async with sem:
        start = time.monotonic()
        try:
            await _post_tag(job, tag, start)
        finally:
            progress.update(task_id, advance=1, totals=job.totals.summary())


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
    parser.add_argument(
        "--skip-recent",
        type=float,
        default=3.0,
        metavar="DAYS",
        help="跳过最近 N 天内已成功导入的 tag（默认 3，设 0 关闭）。"
        "代价是这段时间内的新图要等冷却过后才会被发现",
    )
    parser.add_argument("--state-file", type=Path, default=STATE_FILE, help="冷却状态文件路径")
    parser.add_argument(
        "--full",
        action="store_true",
        help="忽略冷却，并让服务端走完整分页（不在「整页已导入」处早停）。"
        "用来补齐 Danbooru 事后才补标到旧图的 post，建议定期跑一次",
    )
    args = parser.parse_args()

    tags = [line.strip() for line in args.tags_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    console = Console()
    if not tags:
        console.print(f"[red]No tags found in {args.tags_file}[/]")
        return

    state = TagState(args.state_file, legacy_path=LEGACY_STATE_FILE)
    totals = Totals()
    if args.full or args.skip_recent <= 0:
        pending = tags
    else:
        now = datetime.now(tz=UTC)
        pending = [tag for tag in tags if not state.is_fresh(tag, now, args.skip_recent)]
    cooled = len(tags) - len(pending)

    mode = "full scan" if args.full else "incremental"
    console.print(
        f"Loaded [cyan]{len(tags)}[/] tags from {args.tags_file}, "
        f"concurrency=[cyan]{args.concurrency}[/], mode=[cyan]{mode}[/]"
    )
    if cooled:
        console.print(
            f"Skipping [dim]{cooled}[/] tags imported within {args.skip_recent:g}d "
            f"(--skip-recent 0 或 --full 可绕过)"
        )
    if not pending:
        console.print("[green]Nothing to do — every tag is inside its cooldown.[/]")
        return

    sem = asyncio.Semaphore(args.concurrency)
    # A finite read timeout (was None = wait forever) so a stalled server turns
    # into a retry instead of an invisible hang. Sized to cover a legitimately
    # long import (CDN download is throttled to ~1 req/s server-side); raise
    # --read-timeout for tags with thousands of new files.
    timeout = httpx.Timeout(connect=30.0, read=args.read_timeout, write=30.0, pool=30.0)
    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency)
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
        job = Job(
            client=client,
            console=console,
            totals=totals,
            state=state,
            retries=args.retries,
            full_scan=args.full,
        )
        with progress:
            task_id = progress.add_task("tags", total=len(pending), totals=totals.summary())
            await asyncio.gather(
                *(download_one(job, tag, sem, progress, task_id) for tag in pending),
            )

    total_elapsed = time.monotonic() - total_start
    cooled_part = f" / [dim]{cooled} cooled[/]" if cooled else ""
    console.rule("[bold]Done")
    console.print(
        f"Time: [cyan]{total_elapsed:.1f}s[/]  "
        f"Tags: [green]{len(pending) - len(totals.failed_tags)} ok[/] / [red]{len(totals.failed_tags)} failed[/]"
        f"{cooled_part}  "
        f"Files: [green]{totals.downloaded} downloaded[/] / [yellow]{totals.skipped} skipped[/] / [red]{totals.failed_files} failed[/]",
    )
    if totals.failed_tags:
        console.print("[red]Failed tags:[/]")
        for tag, err in totals.failed_tags:
            console.print(f"  [red]{tag}[/]: {err}")


if __name__ == "__main__":
    asyncio.run(main())
