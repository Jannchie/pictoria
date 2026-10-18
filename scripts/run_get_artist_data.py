# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "rich"]
# ///
"""批量让本地服务从 Danbooru 拉取指定 tag 的图片。

服务端是作业制：``POST /v2/danbooru-imports`` 立即回一个作业，导入（翻列表 + 分块下载，
每块落一次库）在服务端后台跑，这里每 ``--poll-interval`` 秒 ``GET`` 一次看进度，直到
done / failed。所以不再有长请求、不再有读超时：一个几百张新图的 tag 下十几分钟也只是
多轮询几次。

去重在服务端：同一个 tag 已有排队中或在跑的作业时，再提交拿回的是**同一个**作业。所以
网络抖动后的重提、API 重启后的重提都是安全的，永远不会让两个导入抢同一份 CDN 配额。

并发：服务端同时只跑 2 个作业（CDN 侧是 pool-wide ≈1 req/s 的节流，再多只是把配额
劈碎），多提交的在服务端排队。这里默认同时在飞 4 个 tag，是为了让服务端一个作业结束时
队列里已经有下一个，流水线不断档。

Ctrl+C 只停这一侧：已经提交的作业照样在服务端跑完、落库。

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
from typing import Any

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

LOCAL_API = "http://localhost:4777/v2/danbooru-imports"
TAGS_FILE = Path(__file__).parent / "tags.txt"
STATE_FILE = Path(__file__).parent / ".run_get_artist_data_state.jsonl"
#: 整份重写的旧格式；存在就读一次作为底，不再写入。
LEGACY_STATE_FILE = Path(__file__).parent / ".run_get_artist_data_state.json"

#: 每个请求都是短的（提交 / 查一次状态），30 秒还不回就是 API 卡住了，当网络错误重试。
_HTTP_TIMEOUT = httpx.Timeout(30.0)
#: 网络错误 / 5xx 的退避：从 1 秒翻倍到 30 秒封顶，总时长受 ``--api-patience`` 约束。
_BACKOFF_START = 1.0
_BACKOFF_MAX = 30.0
#: 轮询拿到 404（API 重启过，内存里的作业没了）时最多重提几次。
_MAX_RESUBMITS = 3


class TagFailedError(Exception):
    """这个 tag 这一轮算失败：作业 failed、或重提次数用完。"""


class JobLostError(Exception):
    """轮询到 404：作业在服务端不存在了（API 重启或已过期）。"""


@dataclass
class Totals:
    downloaded: int = 0
    skipped: int = 0
    failed_files: int = 0
    failed_tags: list[tuple[str, str]] = field(default_factory=list)
    #: 在飞作业的下载进度：作业 id → (processed, pending)。
    in_flight: dict[str, tuple[int, int]] = field(default_factory=dict)

    def summary(self) -> str:
        text = f"[green]DL {self.downloaded}[/] [yellow]SK {self.skipped}[/] [red]ER {self.failed_files}[/]"
        if self.in_flight:
            done = sum(p for p, _ in self.in_flight.values())
            total = sum(n for _, n in self.in_flight.values())
            text += f" [dim]· running {done}/{total}[/]"
        return text


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
    full_scan: bool
    poll_interval: float
    api_patience: float
    progress: Progress
    task_id: TaskID


def _is_retryable(exc: Exception) -> bool:
    """API 暂时不可用（重启中、卡住、5xx）—— 值得等一等再来。"""
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= httpx.codes.INTERNAL_SERVER_ERROR
    return isinstance(exc, httpx.TransportError)  # 含 TimeoutException


async def _request(job: Job, method: str, url: str, **kwargs: Any) -> httpx.Response:
    """发一个短请求；网络错误 / 5xx 按退避重试，直到 ``--api-patience`` 用完。

    404 原样交回调用方（轮询要据此重提），其余 4xx 直接抛 —— 那是请求本身不对，
    重试也一样。
    """
    deadline = time.monotonic() + job.api_patience
    backoff = _BACKOFF_START
    while True:
        try:
            resp = await job.client.request(method, url, **kwargs)
            if resp.status_code != httpx.codes.NOT_FOUND:
                resp.raise_for_status()
        except httpx.HTTPError as exc:
            if not _is_retryable(exc) or time.monotonic() + backoff > deadline:
                raise
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _BACKOFF_MAX)
            continue
        return resp


async def _submit(job: Job, tag: str) -> str:
    """提交（幂等：同 tag 已有在排队 / 在跑的作业时服务端回那一个），返回作业 id。"""
    resp = await _request(job, "POST", LOCAL_API, json={"tags": tag, "fullScan": job.full_scan})
    if resp.status_code == httpx.codes.NOT_FOUND:
        # 提交端点本身 404 = 服务端还是旧代码。
        msg = f"{LOCAL_API} not found — is the API running the job-based import? please restart it"
        raise TagFailedError(msg)
    return resp.json()["id"]


async def _wait(job: Job, job_id: str) -> dict[str, Any]:
    """轮询一个作业直到 done / failed。404 → :class:`JobLostError`。"""
    while True:
        resp = await _request(job, "GET", f"{LOCAL_API}/{job_id}")
        if resp.status_code == httpx.codes.NOT_FOUND:
            raise JobLostError(job_id)
        body = resp.json()
        if body["state"] in {"done", "failed"}:
            return body
        if body.get("phase") == "downloading":
            job.totals.in_flight[job_id] = (int(body["processed"]), int(body["pending"]))
            job.progress.update(job.task_id, totals=job.totals.summary())
        await asyncio.sleep(job.poll_interval)


async def _run_tag(job: Job, tag: str) -> dict[str, Any]:
    """提交并等到结束，返回 done 的作业。

    作业丢了（API 重启）就重提 —— 导入幂等，已经落库的不会再下 —— 最多 ``_MAX_RESUBMITS`` 次。
    作业 failed 不重试：它没进冷却，下次运行自然会再跑。
    """
    for attempt in range(_MAX_RESUBMITS + 1):
        job_id = await _submit(job, tag)
        try:
            final = await _wait(job, job_id)
        except JobLostError:
            if attempt < _MAX_RESUBMITS:
                job.console.print(f"[yellow]…[/] {tag} [dim]job lost (API restarted?), resubmitting[/]")
            continue
        finally:
            job.totals.in_flight.pop(job_id, None)
        if final["state"] == "failed":
            raise TagFailedError(final.get("error") or "import failed")
        return final
    msg = f"job lost {_MAX_RESUBMITS + 1} times in a row"
    raise TagFailedError(msg)


def _record_fail(job: Job, tag: str, err: str, start: float) -> None:
    job.totals.failed_tags.append((tag, err))
    elapsed = time.monotonic() - start
    job.console.print(f"[red]✗[/] {tag} [dim]{elapsed:.1f}s[/] - {err}")


async def download_one(job: Job, tag: str, sem: asyncio.Semaphore) -> None:
    async with sem:
        start = time.monotonic()
        try:
            final = await _run_tag(job, tag)
        except TagFailedError as exc:
            _record_fail(job, tag, str(exc), start)
        except Exception as exc:  # 一个 tag 的意外（包括 API 耐心用完）不该拖垮整轮
            _record_fail(job, tag, f"{type(exc).__name__}: {exc}", start)
        else:
            dl = int(final.get("downloaded", 0))
            sk = int(final.get("skipped", 0))
            fl = int(final.get("failed", 0))
            totals = job.totals
            totals.downloaded += dl
            totals.skipped += sk
            totals.failed_files += fl
            # 只有整个 tag 干净跑完才进冷却；有文件失败就不记，下次照常重试。
            if fl == 0:
                job.state.mark_ok(tag, datetime.now(tz=UTC))
            elapsed = time.monotonic() - start
            job.console.print(f"[green]✓[/] {tag} ([cyan]dl={dl}[/] [yellow]sk={sk}[/] [red]err={fl}[/]) [dim]{elapsed:.1f}s[/]")
        finally:
            job.progress.update(job.task_id, advance=1, totals=job.totals.summary())


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="同时在飞的 tag 数（默认 4）。服务端同时只跑 2 个作业，多提交的在服务端排队，保证一个作业结束时下一个已经就位",
    )
    parser.add_argument("--tags-file", type=Path, default=TAGS_FILE, help="tag 列表文件路径")
    parser.add_argument("--poll-interval", type=float, default=2.0, help="轮询作业状态的间隔秒数（默认 2）")
    parser.add_argument(
        "--api-patience",
        type=float,
        default=300.0,
        help="API 连不上 / 5xx 时最多等多少秒（默认 300），超过才算这个 tag 失败。用来扛过 API 重启；重启丢掉的作业会被自动重新提交",
    )
    parser.add_argument(
        "--skip-recent",
        type=float,
        default=3.0,
        metavar="DAYS",
        help="跳过最近 N 天内已成功导入的 tag（默认 3，设 0 关闭）。代价是这段时间内的新图要等冷却过后才会被发现",
    )
    parser.add_argument("--state-file", type=Path, default=STATE_FILE, help="冷却状态文件路径")
    parser.add_argument(
        "--full",
        action="store_true",
        help="忽略冷却，并让服务端走完整分页（不在「整页已导入」处早停）。用来补齐 Danbooru 事后才补标到旧图的 post，建议定期跑一次",
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
    console.print(f"Loaded [cyan]{len(tags)}[/] tags from {args.tags_file}, concurrency=[cyan]{args.concurrency}[/], mode=[cyan]{mode}[/]")
    if cooled:
        console.print(f"Skipping [dim]{cooled}[/] tags imported within {args.skip_recent:g}d (--skip-recent 0 或 --full 可绕过)")
    if not pending:
        console.print("[green]Nothing to do — every tag is inside its cooldown.[/]")
        return

    sem = asyncio.Semaphore(args.concurrency)
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

    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, limits=limits) as client:
        with progress:
            task_id = progress.add_task("tags", total=len(pending), totals=totals.summary())
            job = Job(
                client=client,
                console=console,
                totals=totals,
                state=state,
                full_scan=args.full,
                poll_interval=args.poll_interval,
                api_patience=args.api_patience,
                progress=progress,
                task_id=task_id,
            )
            await asyncio.gather(*(download_one(job, tag, sem) for tag in pending))

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
