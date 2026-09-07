"""Self-consistency on listwise retests: when you rank the same group twice, how often do you agree with yourself?

This is the ceiling for anything the model can learn from boundary comparisons. The sampler
deliberately builds groups the model cannot separate (|d-silva| <= 0.10), so a model scoring
0.60 there is either still learning or already at the noise floor - and the right next move
is opposite in the two cases. Only this number tells them apart.

A retest is two rankings of the SAME member set (see `Sampler.sampleRepeatGroups`, which only
re-serves groups ranked exactly once and at least REPEAT_MIN_AGE_DAYS ago). Pairs are compared
by direction: both rankings put A before B, or they disagree. Stratified by |d-silva| because
that is what the sampler selects on - the narrow strata are the ones the labels are bought for.

    uv run python scripts/listwise_retest.py
"""
import json
import math
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

import sqlite_vec

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from paths import db_path

#: 显式参数优先，否则跟着 paths.py —— 也就是跟着 PICTORIA_TARGET_DIR / DB_PATH。
#: 自己推一份默认路径的脚本会在非默认库上静默报出**另一个库**的数字。
DB_PATH = sys.argv[1] if len(sys.argv) > 1 else str(db_path())
STRATA = [(0.00, 0.01), (0.01, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 99.0)]


def wilson(ok: int, n: int) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p, z = ok / n, 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - m), min(1.0, c + m))


def main() -> None:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.enable_load_extension(True)
    sqlite_vec.load(con)
    con.enable_load_extension(False)

    silva = dict(con.execute("SELECT post_id, score FROM post_aesthetic_scores WHERE scorer = 'silva'"))
    groups: dict[str, list[tuple[str, list[int]]]] = defaultdict(list)
    for post_ids, ranking, created in con.execute(
        "SELECT post_ids, ranking, created_at FROM listwise_annotations"
        " WHERE dimension = 'overall' AND ranking != '[]' ORDER BY created_at",
    ):
        members = json.loads(post_ids)
        groups[",".join(map(str, sorted(members)))].append((created, json.loads(ranking)))
    con.close()

    retests = [(k, v) for k, v in groups.items() if len(v) >= 2]
    if not retests:
        print("No retests yet. Turn on the retest switch in the annotate view and rank ~50 groups.")
        print(f"(scanned {len(groups)} distinct member sets)")
        return

    tot_ok = tot_n = 0
    strat = {s: [0, 0] for s in STRATA}
    for _, takes in retests:
        (_, first), (_, second) = takes[0], takes[1]
        pos2 = {pid: i for i, pid in enumerate(second)}
        for i, a in enumerate(first):
            for b in first[i + 1 :]:
                if a not in pos2 or b not in pos2:
                    continue
                tot_n += 1
                agree = pos2[a] < pos2[b]  # first said a > b; does the second still?
                tot_ok += agree
                if a in silva and b in silva:
                    d = abs(silva[a] - silva[b])
                    for s in STRATA:
                        if s[0] <= d < s[1]:
                            strat[s][1] += 1
                            strat[s][0] += agree
                            break

    lo, hi = wilson(tot_ok, tot_n)
    print(f"retested groups: {len(retests)}   pairs compared: {tot_n}")
    print(f"self-consistency: {tot_ok / tot_n:.3f}  [{lo:.3f}, {hi:.3f}]   (0.5 = coin flip)\n")
    print("by |d-silva| - the narrow rows are what the sampler actually buys")
    for s in STRATA:
        ok, n = strat[s]
        if not n:
            continue
        lo, hi = wilson(ok, n)
        top = "inf " if s[1] > 90 else f"{s[1]:.2f}"
        print(f"  {s[0]:.2f}-{top}  n={n:<5} {ok / n:.3f}  [{lo:.3f}, {hi:.3f}]")
    print("\nCompare against the model's accuracy on the same kind of pair (agreement_eval.py, Q1: ~0.60).")
    print("If your own number is near that, boundary listwise is buying coin flips - stop it.")
    print("If it is >= 0.75, the signal is real and the model has not learned it yet.")


if __name__ == "__main__":
    main()
