"""Eyeball the pairs variant grouping is about to merge.

The calibration numbers say LPIPS separates "same drawing, edited" from
"different drawing" -- but they say it about *synthetic* edits and about an
aggregate. The pairs that actually decide whether this feature is trustworthy
are the ones at the far end of the grey band: SigLIP thinks they are fairly
different, LPIPS says same picture. If that bucket is wrong, the merge is wrong,
and no percentile will tell you -- only looking will.

So this dumps a side-by-side HTML page, sampled across the SigLIP range, with
both distances printed under each pair. Open it, scroll, and look for two
pictures that are not the same drawing.

Read-only on the database, same as `inspect_db.py`.

Usage (from ``server/``)::

    uv run python scripts/review_edges.py --out .lpips/review.html
"""

from __future__ import annotations

import argparse
import html
import random
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ai.lpips import LPIPS_SAME_THRESHOLD_DEFAULT
from paths import db_path, thumbnails_root

#: 判"同一张画"的上限。**导入而不是抄一个数** —— 这个脚本的全部用途就是人眼复核
#: "哪些对会被判同"，阈值抄错一档，看到的正是被真正阈值排除掉的那批，而结论会被
#: 拿去调阈值。
SAME_THRESHOLD = LPIPS_SAME_THRESHOLD_DEFAULT


def _fetch(con: sqlite3.Connection, where: str, limit: int, seed: int) -> list[tuple]:
    rows = con.execute(
        "SELECT e.post_a, e.post_b, e.siglip_dist, e.lpips_dist, a.full_path, b.full_path "
        "FROM post_variant_edges e "
        "JOIN posts a ON a.id = e.post_a JOIN posts b ON b.id = e.post_b "
        f"WHERE e.lpips_dist IS NOT NULL AND {where}",
    ).fetchall()
    rng = random.Random(seed)  # noqa: S311  # sampling, not crypto
    rng.shuffle(rows)
    return rows[:limit]


def _card(row: tuple, thumbs: Path) -> str:
    post_a, post_b, siglip, lpips, path_a, path_b = row
    verdict = "SAME" if lpips <= SAME_THRESHOLD else "different"
    cls = "same" if lpips <= SAME_THRESHOLD else "diff"
    left = (thumbs / path_a).as_uri()
    right = (thumbs / path_b).as_uri()
    return (
        f'<div class="pair {cls}">'
        f'<div class="imgs"><img src="{html.escape(left)}" loading="lazy">'
        f'<img src="{html.escape(right)}" loading="lazy"></div>'
        f'<div class="meta">#{post_a} / #{post_b} &nbsp; siglip {siglip:.4f} &nbsp; '
        f"lpips <b>{lpips:.3f}</b> &nbsp; {verdict}</div></div>"
    )


#: near-miss（被判为不同的那一批）按 SigLIP 距离拆开。
#:
#: 拆开才有用：near-miss 里四分之三来自 siglip >= 0.04 的远端，而"把阈值整体提上去"
#: 对近段和远段的代价完全不同 —— 近段几乎零风险，远段是误合并的主要来源。所以要问的
#: 不是"阈值该不该提"，而是"哪一段该提"。
NEAR_MISS_SECTIONS = [
    (
        "near miss @ siglip < 0.02 (nearest band)",
        "SigLIP 先验最强的一段。这里如果有真差分被拦下，把这一段的阈值放宽到 0.60 几乎零代价。",  # noqa: RUF001
        f"e.siglip_dist < 0.02 AND e.lpips_dist > {SAME_THRESHOLD} AND e.lpips_dist <= 0.60",
    ),
    (
        "near miss @ siglip 0.02-0.04 (middle band)",
        "中间段。放宽到 0.50 的代价可控，再往上要谨慎。",  # noqa: RUF001
        f"e.siglip_dist >= 0.02 AND e.siglip_dist < 0.04 AND e.lpips_dist > {SAME_THRESHOLD} AND e.lpips_dist <= 0.60",
    ),
    (
        "near miss @ siglip >= 0.04 (far band)",
        "远端。near-miss 的四分之三在这里，但这一段放宽阈值就是误合并的主要来源 —— 除非这里也有明显的真差分，否则不动。",  # noqa: RUF001
        f"e.siglip_dist >= 0.04 AND e.lpips_dist > {SAME_THRESHOLD} AND e.lpips_dist <= 0.60",
    ),
]

SECTIONS = [
    (
        "far-end merges (siglip >= 0.045, judged SAME)",
        "这一组最值得看：SigLIP 认为差挺多，LPIPS 却说是同一张画。误合并如果存在，最可能在这里。",  # noqa: RUF001
        f"e.siglip_dist >= 0.045 AND e.lpips_dist <= {SAME_THRESHOLD}",
    ),
    (
        f"boundary merges (lpips 0.30-{SAME_THRESHOLD})",
        "刚好压线判同的。阈值往下调会先丢掉这一批 —— 看看它们值不值得留。",
        f"e.lpips_dist > 0.30 AND e.lpips_dist <= {SAME_THRESHOLD}",
    ),
    (
        f"near misses (lpips {SAME_THRESHOLD}-0.60)",
        "刚好被判为不同的。如果这里面有明显的差分，说明阈值偏紧。",  # noqa: RUF001
        f"e.lpips_dist > {SAME_THRESHOLD} AND e.lpips_dist <= 0.60",
    ),
    (
        "core merges (siglip < 0.02, judged SAME)",
        "灰带最近的一档，应该全是显而易见的差分。这一组用来确认没有系统性错误。",  # noqa: RUF001
        f"e.siglip_dist < 0.02 AND e.lpips_dist <= {SAME_THRESHOLD}",
    ),
]

STYLE = """
body { background:#141416; color:#e6e6e6; font:13px/1.5 system-ui,sans-serif; margin:0; padding:24px; }
h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:15px; margin:32px 0 2px; }
p.note { color:#9a9aa2; margin:0 0 12px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:14px; }
.pair { background:#1d1d21; border-radius:6px; padding:8px; border-left:3px solid #444; }
.pair.same { border-left-color:#4a8; } .pair.diff { border-left-color:#a55; }
.imgs { display:flex; gap:6px; } .imgs img { width:50%; height:150px; object-fit:contain; background:#0d0d0f; border-radius:3px; }
.meta { margin-top:6px; color:#9a9aa2; font-size:11px; font-family:ui-monospace,monospace; }
"""


def _render_groups(con: sqlite3.Connection, thumbs: Path, args) -> int:
    """The biggest groups, every member shown.

    Size is the only cheap signal that transitive closure went wrong: one bad
    edge chains two unrelated sets into one. A real variant set of 30 (an
    expression sheet, a colour-variant batch) looks obviously coherent; a
    chained one has a visible seam. Only looking tells them apart.
    """
    groups = con.execute(
        "SELECT canonical_post_id, COUNT(*) + 1 AS n FROM posts "
        "WHERE canonical_post_id IS NOT NULL "
        "GROUP BY canonical_post_id ORDER BY n DESC LIMIT ?",
        (args.per_section,),
    ).fetchall()

    parts = [
        f"<style>{STYLE}.member{{width:120px}}.member img{{width:120px;height:120px;"
        "object-fit:contain;background:#0d0d0f;border-radius:3px}"
        ".group{background:#1d1d21;border-radius:6px;padding:10px;margin-bottom:14px}"
        ".members{display:flex;flex-wrap:wrap;gap:6px}</style>",
        "<h1>largest groups</h1>",
        "<p class='note'>一个真实的差分集（表情差分、配色差分）整组看上去是连贯的；"  # noqa: RUF001
        "被一条坏边串起来的两坨，中间有明显的接缝。翻到有接缝的，把 canonical id 告诉我。</p>",  # noqa: RUF001
    ]
    for canonical, n in groups:
        rows = con.execute(
            "SELECT id, full_path FROM posts WHERE id = ? OR canonical_post_id = ? ORDER BY id",
            (canonical, canonical),
        ).fetchall()
        cards = "".join(
            f'<div class="member"><img src="{html.escape((thumbs / fp).as_uri())}" loading="lazy">'
            f'<div class="meta">#{pid}{" (head)" if pid == canonical else ""}</div></div>'
            for pid, fp in rows
        )
        parts.append(
            f"<div class='group'><div class='meta'>canonical #{canonical} &nbsp; {n} 张</div>"
            f"<div class='members'>{cards}</div></div>",
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(parts), encoding="utf-8")
    print(f"wrote {args.out.resolve()}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path(".lpips/review.html"))
    parser.add_argument("--per-section", type=int, default=24)
    parser.add_argument("--seed", type=int, default=20260907)
    parser.add_argument("--focus", choices=("all", "nearmiss", "groups"), default="all",
                        help="nearmiss: 只看被判为不同的那一批，按 siglip 距离分层")  # noqa: RUF001
    args = parser.parse_args()

    db = db_path()
    if not db.exists():
        print(f"no database at {db}", file=sys.stderr)
        return 1
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    thumbs = thumbnails_root()

    if args.focus == "groups":
        return _render_groups(con, thumbs, args)
    sections = NEAR_MISS_SECTIONS if args.focus == "nearmiss" else SECTIONS
    parts = [f"<style>{STYLE}</style><h1>variant grouping review</h1>", f"<p class='note'>{html.escape(str(db))}</p>"]
    for title, note, where in sections:
        rows = _fetch(con, where, args.per_section, args.seed)
        parts.append(f"<h2>{html.escape(title)} &mdash; {len(rows)}</h2><p class='note'>{note}</p>")
        parts.append("<div class='grid'>" + "".join(_card(r, thumbs) for r in rows) + "</div>")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(parts), encoding="utf-8")
    print(f"wrote {args.out.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
