"""Compare distribution of waifu-scorer vs SigLIP aesthetic scores.

Reads the live SQLite DB (read-only). All percentile / histogram math runs in
Python to avoid SQLite extension dependencies.
"""
from __future__ import annotations

import math
import sqlite3
import sys
from collections import Counter
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB_PATH = sys.argv[1] if len(sys.argv) > 1 else r"E:\pictoria\server\illustration\images\.pictoria\pictoria.sqlite"
print(f"Inspecting: {DB_PATH}")
print(f"Size: {Path(DB_PATH).stat().st_size} bytes\n")

con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=10.0)


def fetch_scores(query: str) -> list[float]:
    return [float(r[0]) for r in con.execute(query).fetchall()]


def summarise(label: str, vals: list[float]) -> None:
    print(f"\n=== {label} ===")
    n = len(vals)
    print(f"  count   : {n}")
    if not n:
        return
    s = sorted(vals)
    mean = sum(s) / n
    var = sum((x - mean) ** 2 for x in s) / max(n - 1, 1)
    sd = math.sqrt(var)

    def pct(q: float) -> float:
        if n == 1:
            return s[0]
        k = q * (n - 1)
        lo = int(math.floor(k))
        hi = int(math.ceil(k))
        if lo == hi:
            return s[lo]
        return s[lo] + (s[hi] - s[lo]) * (k - lo)

    print(f"  min/max : {s[0]:.3f} .. {s[-1]:.3f}")
    print(f"  mean+-sd: {mean:.3f} +- {sd:.3f}")
    print(f"  p01/p05 : {pct(0.01):.3f} / {pct(0.05):.3f}")
    print(f"  p25     : {pct(0.25):.3f}")
    print(f"  median  : {pct(0.50):.3f}")
    print(f"  p75     : {pct(0.75):.3f}")
    print(f"  p95/p99 : {pct(0.95):.3f} / {pct(0.99):.3f}")


def histogram(label: str, vals: list[float], lo: float, hi: float, bins: int) -> None:
    if not vals:
        return
    print(f"\n--- Histogram: {label} ({lo} .. {hi}, {bins} bins) ---")
    width = (hi - lo) / bins
    counts: Counter[int] = Counter()
    for v in vals:
        if v < lo:
            b = 0
        elif v >= hi:
            b = bins - 1
        else:
            b = int((v - lo) / width)
        counts[b] += 1
    max_count = max(counts.values()) if counts else 1
    total = sum(counts.values())
    for b in range(bins):
        c = counts.get(b, 0)
        bar = "#" * int(40 * c / max_count)
        edge_lo = lo + b * width
        edge_hi = edge_lo + width
        pct = (c / total * 100) if total else 0.0
        print(f"  [{edge_lo:5.2f} .. {edge_hi:5.2f})  {c:>7}  {pct:5.1f}% {bar}")


waifu = fetch_scores("SELECT score FROM post_waifu_scores")
siglip = fetch_scores("SELECT score FROM post_aesthetic_scores WHERE scorer = 'siglip-v2-5'")

summarise("Waifu Scorer v3 (post_waifu_scores.score)", waifu)
summarise("SigLIP Aesthetic v2.5 (post_aesthetic_scores 'siglip-v2-5')", siglip)

# Match the upstream score ranges: waifu ~0-10, siglip nominally 1-10 (5.5 = strong).
histogram("Waifu Scorer v3", waifu, 0.0, 10.0, 20)
histogram("SigLIP Aesthetic v2.5", siglip, 0.0, 10.0, 20)


print("\n--- Joint coverage / correlation ---")
rows = con.execute(
    """
    SELECT w.score, s.score
    FROM post_waifu_scores w
    JOIN post_aesthetic_scores s
      ON s.post_id = w.post_id AND s.scorer = 'siglip-v2-5'
    """,
).fetchall()
n_both = len(rows)
print(f"  posts scored by both : {n_both}")
print(f"  waifu-only           : {len(waifu) - n_both}")
print(f"  siglip-only          : {len(siglip) - n_both}")

if n_both >= 2:
    wx = [float(w) for w, _ in rows]
    sy = [float(s) for _, s in rows]
    n = n_both
    mw = sum(wx) / n
    ms = sum(sy) / n
    cov = sum((a - mw) * (b - ms) for a, b in zip(wx, sy, strict=True)) / max(n - 1, 1)
    sw = math.sqrt(sum((a - mw) ** 2 for a in wx) / max(n - 1, 1))
    ss = math.sqrt(sum((b - ms) ** 2 for b in sy) / max(n - 1, 1))
    pearson = cov / (sw * ss) if sw and ss else float("nan")

    def rank_of(xs: list[float]) -> list[float]:
        order = sorted(range(len(xs)), key=lambda i: xs[i])
        ranks = [0.0] * len(xs)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                ranks[order[k]] = avg
            i = j + 1
        return ranks

    rw = rank_of(wx)
    rs = rank_of(sy)
    rm = sum(rw) / n
    rmm = sum(rs) / n
    rcov = sum((a - rm) * (b - rmm) for a, b in zip(rw, rs, strict=True)) / max(n - 1, 1)
    rsw = math.sqrt(sum((a - rm) ** 2 for a in rw) / max(n - 1, 1))
    rss = math.sqrt(sum((b - rmm) ** 2 for b in rs) / max(n - 1, 1))
    spearman = rcov / (rsw * rss) if rsw and rss else float("nan")

    print(f"  Pearson  r           : {pearson:.3f}")
    print(f"  Spearman rho         : {spearman:.3f}")
    print(f"  waifu  mean+-sd      : {mw:.3f} +- {sw:.3f}")
    print(f"  siglip mean+-sd      : {ms:.3f} +- {ss:.3f}")

    # 2D bucket grid: 5x5 over the [p05, p95] range of each metric.
    def grid_edges(xs: list[float]) -> list[float]:
        srt = sorted(xs)

        def q(p: float) -> float:
            k = p * (len(srt) - 1)
            i = int(k)
            return srt[i] + (srt[min(i + 1, len(srt) - 1)] - srt[i]) * (k - i)

        lo, hi = q(0.05), q(0.95)
        return [lo + (hi - lo) * i / 5 for i in range(6)]

    we = grid_edges(wx)
    se = grid_edges(sy)

    def bucket(v: float, edges: list[float]) -> int:
        for i in range(5):
            if v < edges[i + 1]:
                return i
        return 4

    grid = [[0] * 5 for _ in range(5)]
    for a, b in zip(wx, sy, strict=True):
        grid[bucket(a, we)][bucket(b, se)] += 1

    print("\n--- 5x5 joint bucket counts (rows=waifu p05..p95, cols=siglip p05..p95) ---")
    print("  waifu edges : " + " ".join(f"{x:.2f}" for x in we))
    print("  siglip edges: " + " ".join(f"{x:.2f}" for x in se))
    header = "          " + "".join(f"  s{c+1:>3}" for c in range(5))
    print(header)
    for r in range(5):
        row_str = f"  w{r+1:>3}    " + "".join(f"  {grid[r][c]:>4}" for c in range(5))
        print(row_str)

    # Disagreement extremes by z-score gap.
    if sw and ss:
        gaps = sorted(
            (
                ((b - ms) / ss) - ((a - mw) / sw),
                a,
                b,
            )
            for a, b in zip(wx, sy, strict=True)
        )
        print("\n--- 5 posts SigLIP loves but Waifu hates (largest +gap) ---")
        for gap, a, b in gaps[-5:][::-1]:
            print(f"  waifu={a:5.2f}  siglip={b:5.2f}  z-gap={gap:+.2f}")
        print("\n--- 5 posts Waifu loves but SigLIP hates (largest -gap) ---")
        for gap, a, b in gaps[:5]:
            print(f"  waifu={a:5.2f}  siglip={b:5.2f}  z-gap={gap:+.2f}")

con.close()
