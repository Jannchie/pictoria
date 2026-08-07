"""Render the pairwise comparison graph as a self-contained SVG.

A pairwise queue is only rankable inside a connected component, so the questions worth
asking of it are "did it come out as one piece?" and "did each refill attach to the graph
or start an island?".

The graph is laid out per-component rather than globally. A global force layout spends
almost all of its canvas pushing thousands of two-node fragments apart, and those fragments
carry no structure worth the space: each component gets its own force layout instead, and
the fragments collapse into a count. Node colour is the silva score, so a component whose
layout runs light-to-dark end to end is one where the comparisons agree with the model.

    uv run python scripts/plot_pairwise_graph.py
    uv run python scripts/plot_pairwise_graph.py --dimension finish --out /tmp/f.svg
    uv run python scripts/plot_pairwise_graph.py --tail 800    # only the most recent runs
"""

from __future__ import annotations

import argparse
import html
import os
import pathlib
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass

import numpy as np

SERVER_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

# The band is the very thing this plot exists to check ("跨 band 的桥" below), so it is
# imported rather than copied. A stale copy would not fail — it would quietly report the
# count for a band the sampler no longer uses, in the tool whose job is catching that.
from db.repositories.annotation_queues import _CLOSE_PAIR_MAX_SILVA_DIFF as BAND
from db.scorers import SILVA

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

DEFAULT_DB = os.environ.get("DB_PATH") or str(SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.sqlite")

# A two-node component is one comparison that never grew. There are thousands of them and
# each draws the same picture — a dumbbell — so they are counted, not drawn.
FRAGMENT = 2

# Force-layout iterations. The main component gets the full budget; a shelf cell holding a
# handful of nodes converges long before that, and at ~160 of them the Python-loop overhead
# of the extra rounds outweighs the whole numpy cost.
MAIN_ITERS = 400
SEED = 7


def cell_iters(n: int) -> int:
    return min(140, 20 + 6 * n)


Edge = tuple[int, int, str]
Component = tuple[list[int], list[Edge]]
DECISIVE = ("a", "b")


# ─── data ────────────────────────────────────────────────────────────────────


def load(db: pathlib.Path, dimension: str) -> tuple[list[Edge], dict[int, float]]:
    """Edges in judgement order, plus the silva score of every picture they touch."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10.0)
    edges: list[Edge] = list(
        con.execute(
            "SELECT post_a, post_b, winner FROM pairwise_annotations WHERE dimension = ? ORDER BY id",
            [dimension],
        ),
    )
    ids = {pid for a, b, _ in edges for pid in (a, b)}
    scores: dict[int, float] = {}
    if ids:
        marks = ",".join("?" * len(ids))
        scores = dict(
            con.execute(
                f"SELECT post_id, score FROM post_aesthetic_scores WHERE scorer = ? AND post_id IN ({marks})",
                [SILVA.name, *ids],
            ),
        )
    con.close()
    return edges, scores


# ─── connectivity ────────────────────────────────────────────────────────────


class Union:
    """Union-find that also tracks the component count incrementally.

    The count is maintained per-union rather than recomputed, so feeding edges in one at a
    time to build the timeline stays linear instead of quadratic. That is the only reason
    this exists next to ``_components`` in the repository: the repo answers "what are the
    components" once, this answers "how many are there" after every single edge.
    """

    def __init__(self) -> None:
        self.parent: dict[int, int] = {}
        self.size: dict[int, int] = {}
        self.components = 0

    def add(self, x: int) -> None:
        if x not in self.parent:
            self.parent[x] = x
            self.size[x] = 1
            self.components += 1

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        self.add(a)
        self.add(b)
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.size[ra] < self.size[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        self.size[ra] += self.size[rb]
        self.components -= 1

    def groups(self) -> dict[int, set[int]]:
        out: dict[int, set[int]] = {}
        for pid in self.parent:
            out.setdefault(self.find(pid), set()).add(pid)
        return out


def build(edges: list[Edge]) -> Union:
    uf = Union()
    for a, b, _ in edges:
        uf.union(a, b)
    return uf


def timeline(edges: list[Edge], *, decisive_only: bool) -> list[tuple[int, int]]:
    """``(edges so far, component count)`` after each edge."""
    uf = Union()
    out: list[tuple[int, int]] = []
    seen = 0
    for a, b, w in edges:
        if decisive_only and w not in DECISIVE:
            continue
        seen += 1
        uf.union(a, b)
        out.append((seen, uf.components))
    return out


def split(edges: list[Edge], uf: Union) -> list[Component]:
    """``(members, edges)`` per component, largest first."""
    groups = uf.groups()
    by_root: dict[int, list[Edge]] = {r: [] for r in groups}
    for a, b, w in edges:
        by_root[uf.find(a)].append((a, b, w))
    out = [(sorted(m), by_root[r]) for r, m in groups.items()]
    out.sort(key=lambda c: -len(c[0]))
    return out


@dataclass(frozen=True)
class Graph:
    """One analysed dimension. Built once, read by both the stdout summary and the SVG.

    The two used to compute the same six numbers independently, which is the one thing this
    script cannot afford to get wrong: the numbers ARE its output.
    """

    edges: list[Edge]
    scores: dict[int, float]
    uf: Union
    comps: list[Component]
    dec_components: int

    @property
    def pictures(self) -> int:
        return len(self.uf.parent)

    @property
    def main(self) -> list[int]:
        return self.comps[0][0] if self.comps else []

    @property
    def main_share(self) -> float:
        return len(self.main) / self.pictures if self.pictures else 0.0

    @property
    def wide(self) -> int:
        """Edges spanning MORE than one band — bridges and calibration edges, by design."""
        s = self.scores
        return sum(1 for a, b, _ in self.edges if a in s and b in s and abs(s[a] - s[b]) > BAND)

    @property
    def seen_scores(self) -> list[float]:
        return [self.scores[p] for p in self.uf.parent if p in self.scores]


def analyse(edges: list[Edge], scores: dict[int, float]) -> Graph:
    uf = build(edges)
    return Graph(edges, scores, uf, split(edges, uf), build([e for e in edges if e[2] in DECISIVE]).components)


# ─── force layout ────────────────────────────────────────────────────────────


def force_layout(n: int, links: np.ndarray, iters: int) -> np.ndarray:
    """Fruchterman-Reingold in numpy. Returns an ``(n, 2)`` array normalised to [0, 1].

    Repulsion is all-pairs, but never materialises the ``(n, n, 2)`` displacement tensor the
    textbook form does. Writing the sum out,

        disp_i = Σ_j (p_i - p_j)·w_ij = p_i·Σ_j w_ij - (W @ pos)_i

    leaves only ``(n, n)`` arrays and turns both reductions into BLAS calls; the pair
    distances come from the Gram matrix for the same reason. At the ~1100 nodes of the
    largest component that is 35 MB of temporaries per step against 5 MB, and 400 steps of a
    memory-bound reduction against 400 gemms — measured 21.7s -> 4.4s.
    """
    if n < 2:
        return np.full((n, 2), 0.5, dtype=np.float32)
    rng = np.random.default_rng(SEED)
    pos = (rng.random((n, 2), dtype=np.float32) * 2 - 1).astype(np.float32)
    k2 = np.float32(1.0 / n)  # k = sqrt(1/n), and only k² is ever needed
    k = np.float32(np.sqrt(k2))
    temp = np.float32(0.35)
    # An empty (0, 2) array keeps a_idx/b_idx real arrays, so the attraction scatter is a
    # no-op on an edgeless component instead of needing a branch.
    a_idx, b_idx = links[:, 0], links[:, 1]
    for _ in range(iters):
        sq = (pos * pos).sum(1)
        # Gram form of the pairwise square distance; the clamp also absorbs the float32
        # cancellation that can push a near-zero distance slightly negative.
        dist2 = np.maximum(sq[:, None] + sq[None, :] - 2.0 * (pos @ pos.T), np.float32(1e-6))
        np.fill_diagonal(dist2, np.float32(np.inf))
        weight = k2 / dist2  # repulsion k²/d along the unit vector == delta * k²/d²
        disp = pos * weight.sum(1)[:, None] - weight @ pos
        de = pos[a_idx] - pos[b_idx]
        dl = np.maximum(np.linalg.norm(de, axis=1, keepdims=True), np.float32(1e-6))
        f = de * (dl / k)  # attraction d²/k along the unit vector == de * d/k
        # bincount rather than np.subtract.at: ufunc.at is the unbuffered slow path.
        for ax in (0, 1):
            disp[:, ax] += (np.bincount(b_idx, f[:, ax], n) - np.bincount(a_idx, f[:, ax], n)).astype(np.float32)
        dl = np.maximum(np.linalg.norm(disp, axis=1, keepdims=True), np.float32(1e-6))
        pos += disp / dl * np.minimum(dl, temp)
        temp *= np.float32(0.975)
    lo, hi = pos.min(0), pos.max(0)
    span = np.maximum(hi - lo, np.float32(1e-6)).max()  # one scale for both axes: no shearing
    return (pos - lo) / span


# ─── rendering ───────────────────────────────────────────────────────────────

W = 1600
M = 70
PLOT_W = W - 2 * M
MAIN_W = int(PLOT_W * 0.60)
GAP = 34
GRID_X = M + MAIN_W + GAP
GRID_W = PLOT_W - MAIN_W - GAP
CANVAS_H = 980

# Sequential ramp for the silva score: one hue, light to dark. Dark mode gets its own five
# steps chosen against the dark surface rather than an inversion of these.
RAMP_LIGHT = ["#c5d8e8", "#93b6d3", "#628fb8", "#3c6795", "#1d4066"]
RAMP_DARK = ["#2b4a63", "#3e6d92", "#5c95bf", "#88b8db", "#bcdcf3"]
STEPS = len(RAMP_LIGHT)

PALETTE_LIGHT = "--bg:#ffffff; --fg:#16181d; --muted:#6b7280; --axis:#d9dce2; --edge:#8b95a3; --line:#2f5d8a;"
PALETTE_DARK = "--bg:#14161a; --fg:#e6e8ec; --muted:#9aa1ad; --axis:#333842; --edge:#69737f; --line:#6ba3d6;"

CSS = """
  text { font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; fill: var(--fg); }
  .t    { font-size: 19px; font-weight: 620; }
  .sub  { font-size: 13px; fill: var(--muted); }
  .lbl  { font-size: 12px; fill: var(--muted); }
  .num  { font-size: 12px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .big  { font-size: 26px; font-weight: 640; font-variant-numeric: tabular-nums; }
  .cap  { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .grid { stroke: var(--axis); stroke-width: 1; stroke-dasharray: 2 4; }
  .cell { fill: none; stroke: var(--axis); stroke-width: 1; }
  .e    { stroke: var(--edge); stroke-opacity: .55; stroke-width: .8; }
  .e.tie  { stroke-opacity: .28; }
  .e.skip { stroke-opacity: .28; stroke-dasharray: 2 2; }
  .n    { stroke: var(--bg); stroke-width: .8; }
  .line { fill: none; stroke: var(--line); stroke-width: 1.8; }
  .line.alt { stroke: var(--line); stroke-opacity: .55; stroke-dasharray: 4 3; }
"""


def esc(s: object) -> str:
    return html.escape(str(s), quote=False)


def _scale(lo: float, hi: float, a: float, b: float):
    span = (hi - lo) or 1.0
    return lambda v: a + (v - lo) / span * (b - a)


def draw_component(comp: Component, paint, box: tuple[float, float, float, float], r: float, iters: int) -> list[str]:
    """Lay one component out and draw it into ``box`` = (x, y, w, h)."""
    members, edges = comp
    idx = {p: i for i, p in enumerate(members)}
    pairs = [[idx[a], idx[b]] for a, b, _ in edges]
    links = np.array(pairs, dtype=np.int64) if pairs else np.empty((0, 2), dtype=np.int64)
    pos = force_layout(len(members), links, iters)

    bx, by, bw, bh = box
    pad = r + 3
    xs = bx + pad + pos[:, 0] * max(bw - 2 * pad, 1)
    ys = by + pad + pos[:, 1] * max(bh - 2 * pad, 1)
    out = []
    for a, b, w in edges:
        ia, ib = idx[a], idx[b]
        cls = "e" if w in DECISIVE else f"e {w}"
        out.append(f'<line class="{cls}" x1="{xs[ia]:.1f}" y1="{ys[ia]:.1f}" x2="{xs[ib]:.1f}" y2="{ys[ib]:.1f}"/>')
    for pid, x, y in zip(members, xs, ys, strict=True):
        fill, tip = paint(pid)
        out.append(f'<circle class="n" cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{fill}"><title>{esc(tip)}</title></circle>')
    return out


def panel_graph(comps: list[Component], paint, y0: int) -> list[str]:
    """Main component at full size on the left, the rest shelf-packed on the right."""
    drawn = [c for c in comps if len(c[0]) > FRAGMENT]
    frags = [c for c in comps if len(c[0]) <= FRAGMENT]
    if not drawn:
        return []
    main_members, main_edges = drawn[0]
    rest = drawn[1:]

    out = [
        f'<text class="t" x="{M}" y="{y0 - 30}">比较图 · 按连通分量分别布局</text>',
        f'<text class="sub" x="{M}" y="{y0 - 11}">'
        f"节点颜色 = silva 分数（浅→深）；淡实线 = 平局，虚线 = 跳过</text>",  # noqa: RUF001
    ]
    out += draw_component(drawn[0], paint, (M, y0, MAIN_W, CANVAS_H), 2.4, MAIN_ITERS)
    out.append(f'<rect class="cell" x="{M}" y="{y0}" width="{MAIN_W}" height="{CANVAS_H}" rx="3"/>')
    out.append(
        f'<text class="cap" x="{M + 8}" y="{y0 + CANVAS_H - 9}">'
        f"最大分量 · {len(main_members)} 张 · {len(main_edges)} 次比较</text>",
    )

    # Shelf packing: cell side grows with sqrt(size) so a 28-node component gets room a
    # 3-node one does not, and a row closes when the next cell would overflow the width.
    x, y, row_h = float(GRID_X), float(y0), 0.0
    packed = 0
    for comp in rest:
        members = comp[0]
        side = float(np.clip(30 * np.sqrt(len(members) / 3), 34, 132))
        if x + side > GRID_X + GRID_W:
            x, y, row_h = float(GRID_X), y + row_h + 8, 0.0
        if y + side > y0 + CANVAS_H - 22:
            break
        out += draw_component(comp, paint, (x, y, side, side), 1.9, cell_iters(len(members)))
        out.append(f'<rect class="cell" x="{x:.1f}" y="{y:.1f}" width="{side:.1f}" height="{side:.1f}" rx="2"/>')
        x += side + 8
        row_h = max(row_h, side)
        packed += 1

    biggest = len(rest[0][0]) if rest else 0
    note = f"其余 {len(rest)} 个分量（3–{biggest} 张，按大小降序）"  # noqa: RUF001
    if packed < len(rest):
        note += f"，其中 {packed} 个画出"  # noqa: RUF001
    out.append(f'<text class="cap" x="{GRID_X}" y="{y0 + CANVAS_H - 9}">{note}</text>')
    if frags:
        out.append(
            f'<text class="cap" x="{GRID_X}" y="{y0 + CANVAS_H + 10}">'
            f"另有 {len(frags)} 个只比过一次的孤立对（{sum(len(m) for m, _ in frags)} 张）未画出</text>",  # noqa: RUF001
        )
    return out


def panel_ramp(lo: float, hi: float, y0: int) -> list[str]:
    """The score→colour key. One sequential series, so end labels replace a legend box."""
    w = 190
    x0 = W - M - w
    out = [f'<text class="lbl" x="{x0}" y="{y0 - 6}">silva 分数</text>']
    out += [
        f'<rect x="{x0 + i * w / STEPS:.1f}" y="{y0}" width="{w / STEPS:.1f}" height="9" fill="var(--s{i})"/>'
        for i in range(STEPS)
    ]
    out.append(f'<text class="cap" x="{x0}" y="{y0 + 22}">{lo:.2f}</text>')
    out.append(f'<text class="cap" x="{x0 + w}" y="{y0 + 22}" text-anchor="end">{hi:.2f}</text>')
    return out


def panel_timeline(all_tl, dec_tl, y0: int, h: int) -> list[str]:
    """Component count against edges collected — the shape that shows refills detaching.

    A refill that starts its own island is a step UP in this line. The faint series repeats
    the count with ties and skips dropped, since an edge that produced no verdict connects
    the graph without contributing anything a ranking can use.
    """
    if not all_tl:
        return []
    n = all_tl[-1][0]
    peak = max(c for _, c in all_tl)
    x = _scale(0, n, M, M + PLOT_W)
    y = _scale(0, peak, y0 + h, y0)
    out = [
        f'<text class="t" x="{M}" y="{y0 - 30}">连通分量数随标注推进</text>',
        f'<text class="sub" x="{M}" y="{y0 - 11}">'
        f"实线 = 全部边，淡虚线 = 只算分出胜负的边；持续上升 = 每次都在引入新图片而非加深已有比较</text>",  # noqa: RUF001
    ]
    for i in range(5):
        v = peak * i / 4
        yy = y(v)
        out.append(f'<line class="grid" x1="{M}" y1="{yy:.1f}" x2="{M + PLOT_W}" y2="{yy:.1f}"/>')
        out.append(f'<text class="num" x="{M - 8}" y="{yy + 4:.1f}" text-anchor="end">{v:.0f}</text>')
    for series, cls in ((all_tl, "line"), (dec_tl, "line alt")):
        if series:
            pts = " ".join(f"{x(i):.1f},{y(c):.1f}" for i, c in series)
            out.append(f'<polyline class="{cls}" points="{pts}"/>')
    out.append(f'<line class="axis" x1="{M}" y1="{y0 + h}" x2="{M + PLOT_W}" y2="{y0 + h}"/>')
    for i in range(6):
        v = n * i / 5
        out.append(f'<text class="num" x="{x(v):.1f}" y="{y0 + h + 16}" text-anchor="middle">{v:.0f}</text>')
    out.append(f'<text class="lbl" x="{M + PLOT_W}" y="{y0 + h + 32}" text-anchor="end">已收集的比较次数</text>')
    return out


def stat_row(items: list[tuple[str, str]], y: int) -> list[str]:
    out = []
    for i, (label, value) in enumerate(items):
        xx = M + i * (PLOT_W / len(items))
        out.append(f'<text class="lbl" x="{xx:.1f}" y="{y}">{esc(label)}</text>')
        out.append(f'<text class="big" x="{xx:.1f}" y="{y + 30}">{esc(value)}</text>')
    return out


def render(dimension: str, g: Graph) -> str:
    seen = g.seen_scores
    lo, hi = (min(seen), max(seen)) if seen else (0.0, 1.0)
    span = (hi - lo) or 1.0

    def paint(pid: int) -> tuple[str, str]:
        """``(fill, tooltip)`` for one picture — the silva score as a sequential step."""
        s = g.scores.get(pid)
        if s is None:
            return "var(--muted)", f"#{pid} · no silva"
        step = min(int((s - lo) / span * STEPS), STEPS - 1)
        return f"var(--s{step})", f"#{pid} · silva {s:.2f}"

    body: list[str] = [f'<text class="t" x="{M}" y="46">pairwise 比较图 · {esc(dimension)}</text>']
    body += stat_row(
        [
            ("比较次数", f"{len(g.edges)}"),
            ("图片数", f"{g.pictures}"),
            ("连通分量", f"{len(g.comps)}"),
            ("最大分量占比", f"{g.main_share:.0%}"),
            ("去掉平局/跳过", f"{g.dec_components} 个分量"),
            ("跨 band 的桥", f"{g.wide}"),
        ],
        86,
    )
    if seen:
        body += panel_ramp(lo, hi, 152)
    body += panel_graph(g.comps, paint, 210)
    body += panel_timeline(timeline(g.edges, decisive_only=False), timeline(g.edges, decisive_only=True), 1300, 210)
    h = 1590
    ramps = " ".join(
        f"{sel}{{{pal} {' '.join(f'--s{i}:{c};' for i, c in enumerate(ramp))}}}"
        for sel, pal, ramp in (
            (":root", PALETTE_LIGHT, RAMP_LIGHT),
            ("@media (prefers-color-scheme: dark){:root", PALETTE_DARK, RAMP_DARK),
        )
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" viewBox="0 0 {W} {h}">'
        f"<style>{ramps}}}{CSS}</style>"
        f'<rect width="{W}" height="{h}" fill="var(--bg)"/>' + "".join(body) + "</svg>"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=pathlib.Path, default=pathlib.Path(DEFAULT_DB))
    ap.add_argument("--dimension", default="overall")
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("pairwise_graph.svg"))
    ap.add_argument("--tail", type=int, default=0, help="only the most recent N comparisons")
    args = ap.parse_args()

    edges, scores = load(args.db, args.dimension)
    if args.tail:
        edges = edges[-args.tail :]
    if not edges:
        print(f"no pairwise annotations for dimension={args.dimension!r}")
        return

    g = analyse(edges, scores)
    degrees = sorted(Counter(pid for a, b, _ in edges for pid in (a, b)).values())
    kinds = Counter(w for _, _, w in edges)
    frags = sum(1 for m, _ in g.comps if len(m) == FRAGMENT)

    print(f"dimension       {args.dimension}" + (f"  (tail {args.tail})" if args.tail else ""))
    print(f"comparisons     {len(edges)}  ({dict(kinds)})")
    print(f"pictures        {g.pictures}")
    print(f"components      {len(g.comps)}   largest {len(g.main)} ({g.main_share:.1%})")
    print(f"decisive-only   {g.dec_components} components")
    print(f"degree          min {degrees[0]}  median {degrees[len(degrees) // 2]}  max {degrees[-1]}")
    print(f"two-node frags  {frags} components ({frags * FRAGMENT} pictures)")
    print(f"missing silva   {sum(1 for p in g.uf.parent if p not in scores)}")

    args.out.write_text(render(args.dimension, g), encoding="utf-8")
    print(f"\nwrote {args.out.resolve()}")


if __name__ == "__main__":
    main()
