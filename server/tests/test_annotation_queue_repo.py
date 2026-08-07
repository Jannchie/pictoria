"""Tests for AnnotationQueueRepo."""

from __future__ import annotations

from collections import Counter
from typing import TYPE_CHECKING

import pytest
import sqlite_vec

from db.repositories.annotation_queues import _CALIBRATION_GAP, _CLOSE_PAIR_MAX_SILVA_DIFF, AnnotationQueueRepo
from db.repositories.annotations import AnnotationRepo

if TYPE_CHECKING:
    from db.connection import DB


@pytest.fixture
def queues(db: DB) -> AnnotationQueueRepo:
    return AnnotationQueueRepo(db.cursor())


async def test_create_and_list_absolute_queue(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_absolute_queue(
        name="coldstart-1", dimensions=["color", "finish", "composition"], scale=2, post_ids=[1, 2, 3],
    )
    assert qid > 0
    rows = await queues.list_queues()
    assert len(rows) == 1
    queue, total, done = rows[0]
    assert queue.name == "coldstart-1"
    assert queue.kind == "absolute"
    assert queue.dimensions == ["color", "finish", "composition"]
    assert queue.scale == 2
    assert total == 3
    assert done == 0


async def test_next_absolute_items_and_mark_done(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_absolute_queue(name="q", dimensions=["color"], scale=2, post_ids=[1, 2])
    items = await queues.next_absolute_items(qid, limit=10)
    assert [i["position"] for i in items] == [0, 1]
    assert items[0]["post_id"] == 1
    assert "file_name" in items[0]  # join posts，前端拼图片 URL 用

    await queues.mark_done(qid, kind="absolute", position=0)
    items = await queues.next_absolute_items(qid, limit=10)
    assert [i["position"] for i in items] == [1]


async def test_pairwise_queue_roundtrip(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_pairwise_queue(name="pq", dimensions=["color"], pairs=[(1, 2), (2, 3)])
    items = await queues.next_pairwise_items(qid, limit=10)
    assert len(items) == 2
    assert items[0]["a_post_id"] == 1
    assert items[0]["b_post_id"] == 2
    await queues.mark_done(qid, kind="pairwise", position=0)
    items = await queues.next_pairwise_items(qid, limit=10)
    assert len(items) == 1


def _seed_embeddings(db: DB, post_ids: list[int]) -> None:
    cur = db.cursor()
    for pid in post_ids:
        blob = sqlite_vec.serialize_float32([0.01 * pid] * 1152)
        cur.execute("INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)", [pid, blob])


async def test_sample_random_requires_embedding(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3])  # posts 4/5 没有 embedding
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert set(ids) <= {1, 2, 3}
    assert len(ids) == 3


async def test_sample_excludes_already_annotated(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3])
    repo = AnnotationRepo(db.cursor())
    await repo.insert_absolute(post_id=2, dimension="color", scale=2, value=1, rubric_version="color-v1", session_id="s1")
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert 2 not in ids
    # 但只标过别的维度不排除
    ids_finish = await queues.sample_post_ids(count=10, strategy="random", dimensions=["finish"])
    assert 2 in ids_finish


async def test_sample_excludes_pending_queue_items(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3])
    qid = await queues.create_absolute_queue(name="q", dimensions=["color"], scale=2, post_ids=[1])
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert 1 not in ids  # 已在未完成队列里
    await queues.mark_done(qid, kind="absolute", position=0)
    # done 后不再因排队被排除（但仍可能因已标注被排除——本例没有提交事件所以可入选）
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert 1 in ids


async def test_sample_stratified_covers_score_levels(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3, 4, 5])  # seed posts: score 3/0/5/0/3
    ids = await queues.sample_post_ids(count=4, strategy="stratified", dimensions=["color"])
    assert len(ids) == 4
    # 有分的层（3 和 5）必须被覆盖
    cur = db.cursor()
    cur.execute(f"SELECT DISTINCT score FROM posts WHERE id IN ({','.join('?' * len(ids))})", ids)
    scores = {row[0] for row in cur.fetchall()}
    assert 3 in scores
    assert 5 in scores


async def test_sample_pairs_random(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3, 4, 5])
    pairs = await queues.sample_pairs(count=2, strategy="random")
    assert len(pairs) == 2
    flat = [p for pair in pairs for p in pair]
    assert len(flat) == len(set(flat))  # 一图最多出现一次
    for a, b in pairs:
        assert a != b


def _seed_distinct_embeddings(db: DB, post_ids: list[int]) -> None:
    """One-hot embeddings: every pair is orthogonal (cosine distance ~1), so
    the similar-pair KNN treats all seeded posts as mutual neighbours and none
    get dropped as near-duplicates — pairing is then driven purely by score."""
    cur = db.cursor()
    for pid in post_ids:
        vec = [0.0] * 1152
        vec[pid % 1152] = 1.0
        cur.execute("INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)", [pid, sqlite_vec.serialize_float32(vec)])


async def test_sample_pairs_similar_respects_score_band(db: DB, queues: AnnotationQueueRepo) -> None:
    # fixture scores: 1->3, 2->0, 3->5, 4->0, 5->3. All five are mutual
    # neighbours, so pairing is driven by the score band: 1 & 5 (both 3) pair,
    # 2 & 4 (unrated) pair, and 3 (score 5) has no same/adjacent-score partner
    # so it must be stranded rather than forced into a foregone 5-vs-3.
    _seed_distinct_embeddings(db, [1, 2, 3, 4, 5])
    pairs = await queues.sample_pairs(count=2, strategy="similar")
    assert len(pairs) == 2
    flat = [p for pair in pairs for p in pair]
    assert len(flat) == len(set(flat))  # disjoint
    for a, b in pairs:
        assert a != b
    assert 3 not in flat  # score-5 post has no in-band partner (1/5 are score 3)
    score = {1: 3, 2: 0, 3: 5, 4: 0, 5: 3}
    for a, b in pairs:
        if score[a] and score[b]:  # both rated -> must be same/adjacent bucket
            assert abs(score[a] - score[b]) <= 1


def _seed_silva(db: DB, scores: dict[int, float]) -> None:
    cur = db.cursor()
    cur.execute("DELETE FROM post_aesthetic_scores")  # drop conftest's preset (4->0.4, 5->0.9) so the test fully controls the band
    for pid, s in scores.items():
        cur.execute("INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, 'silva', ?)", [pid, s])


async def test_sample_pairs_close_pairs_by_silva_band(db: DB, queues: AnnotationQueueRepo) -> None:
    # All five are mutual neighbours (orthogonal embeddings), so pairing is driven by
    # the SILVA score gap, not the human band: 1/2/3 cluster near 0.5 and 4/5 near 0.9.
    # 排序后 [1:.50, 3:.51, 2:.52, 4:.90, 5:.91]，spine 连出 (1,3)(3,2)(4,5)——
    # (2,4) 相距 0.38 超出 band 所以断开，两个团各自成链。
    #
    # 注意 close 已**不再** disjoint：一张图参与 _CLOSE_PAIR_DEGREE 次比较是有意为之，
    # 否则比较图退化成孤立边、推不出全局序（见下方 connected/degree 两个测试）。
    # 保持不变的契约是：同一对不问两次，且**局部边**都在 band 内——
    # 两个团之间的桥是唯一的例外，它存在的意义就是跨过 band 把两条链接起来。
    _seed_distinct_embeddings(db, [1, 2, 3, 4, 5])
    silva = {1: 0.50, 2: 0.52, 3: 0.51, 4: 0.90, 5: 0.91}
    _seed_silva(db, silva)
    pairs = await queues.sample_pairs(count=3, strategy="close")
    assert len(pairs) == 3
    assert len({frozenset(p) for p in pairs}) == 3  # 同一对不重复
    for a, b in pairs:
        assert a != b
    in_band = [p for p in pairs if abs(silva[p[0]] - silva[p[1]]) <= _CLOSE_PAIR_MAX_SILVA_DIFF]
    assert len(pairs) - len(in_band) <= 1, "跨 band 的边超过一条——桥不该多于团数减一"


async def test_sample_pairs_close_skips_posts_without_silva(db: DB, queues: AnnotationQueueRepo) -> None:
    # Only 1 & 2 have a (close) SILVA score; the rest are unscored and must be skipped,
    # so the single in-band pair (1,2) is all that can be formed.
    _seed_distinct_embeddings(db, [1, 2, 3, 4, 5])
    _seed_silva(db, {1: 0.40, 2: 0.45})
    pairs = await queues.sample_pairs(count=5, strategy="close")
    assert pairs == [(1, 2)] or pairs == [(2, 1)]


async def test_sample_absolute_items_carry_image_fields(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2])
    items = await queues.sample_absolute_items(count=10, strategy="random", dimensions=["color"])
    assert len(items) == 2
    assert {"post_id", "file_path", "file_name", "extension", "sha256", "width", "height"} <= set(items[0])


async def test_sample_pairwise_items_carry_image_fields(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3, 4])
    items = await queues.sample_pairwise_items(count=2)
    assert len(items) == 2
    assert "a_post_id" in items[0]
    assert "b_file_name" in items[0]


# ─── close strategy: a rankable comparison graph ──────────────────
#
# 首轮 2726 条 overall 标注里 96.5% 的图只被比较过一次，比较图是一堆孤立边。
# Bradley-Terry 靠 A>B、B>C ⇒ A>C 的链条推全局序，孤立边给不出任何链——这才是
# 那批数据「温和正向但不显著」的真正原因（不是量不够，也不是 loss 不对）。

def _seed_close_cluster(db: DB, n: int = 12) -> dict[int, float]:
    """n mutual neighbours whose SILVA scores are evenly spread, adjacent gap << band."""
    cur = db.cursor()
    silva = {}
    for i in range(1, n + 1):
        cur.execute("INSERT OR IGNORE INTO posts (id, file_path, file_name, extension, score) VALUES (?, ?, ?, 'png', 0)",
                    [i, f"/p{i}", f"p{i}"])
        vec = [0.0] * 1152
        vec[i % 1152] = 1.0
        cur.execute("INSERT OR REPLACE INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
                    [i, sqlite_vec.serialize_float32(vec)])
        silva[i] = 0.40 + i * 0.01  # 相邻差 0.01，远小于 _CLOSE_PAIR_MAX_SILVA_DIFF
    cur.execute("DELETE FROM post_aesthetic_scores")
    for pid, s in silva.items():
        cur.execute("INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, 'silva', ?)", [pid, s])
    return silva


async def test_close_pairs_give_each_post_several_comparisons(db: DB, queues: AnnotationQueueRepo) -> None:
    """One comparison per picture degenerates into isolated edges; degree builds the chains."""
    _seed_close_cluster(db, n=12)
    pairs = await queues.sample_pairs(count=18, strategy="close")
    assert len(pairs) >= 12
    counts = Counter(p for pair in pairs for p in pair)
    assert max(counts.values()) > 1, "每张图仍然只被比较一次——比较图还是孤立边"
    assert sum(1 for c in counts.values() if c == 1) / len(counts) < 0.5


async def test_close_pairs_form_one_connected_comparison_graph(db: DB, queues: AnnotationQueueRepo) -> None:
    """A ranking can only be inferred inside a connected component."""
    _seed_close_cluster(db, n=12)
    pairs = await queues.sample_pairs(count=18, strategy="close")

    parent = {p: p for pair in pairs for p in pair}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        parent[find(a)] = find(b)
    assert len({find(p) for p in parent}) == 1, "比较图分裂成多个互不连通的孤岛"


async def test_close_pairs_never_repeat_the_same_question(db: DB, queues: AnnotationQueueRepo) -> None:
    """A picture may recur across comparisons; the same pair must never be asked twice."""
    _seed_close_cluster(db, n=12)
    pairs = await queues.sample_pairs(count=20, strategy="close")
    assert len({frozenset(p) for p in pairs}) == len(pairs)
    for a, b in pairs:
        assert a != b


async def test_close_pairs_still_respect_the_silva_band(db: DB, queues: AnnotationQueueRepo) -> None:
    """Degree must not be bought by relaxing difficulty: local edges stay inside the band."""
    silva = _seed_close_cluster(db, n=12)
    pairs = await queues.sample_pairs(count=18, strategy="close")
    local = [p for p in pairs if abs(silva[p[0]] - silva[p[1]]) <= _CLOSE_PAIR_MAX_SILVA_DIFF]
    assert len(local) / len(pairs) >= 0.85


async def _judge(db: DB, a: int, b: int, winner: str = "a") -> None:
    await AnnotationRepo(db.cursor()).insert_pairwise(
        post_a=a, post_b=b, dimension="overall", winner=winner, rubric_version="overall-v1", session_id="s",
    )


async def test_close_never_re_asks_a_judged_pair(db: DB, queues: AnnotationQueueRepo) -> None:
    """Sampling reads the comparison history back, so an answered question never returns.

    The streaming UI has no queue rows to mark done - without this, the only thing keeping
    a pair from being served twice was the front-end's per-session set, which forgets
    everything the moment you close the tab.
    """
    _seed_close_cluster(db, n=12)
    first = await queues.sample_pairs(count=6, strategy="close")
    for a, b in first:
        await _judge(db, a, b)

    again = await queues.sample_pairs(count=6, strategy="close")
    assert not ({frozenset(p) for p in again} & {frozenset(p) for p in first})


async def test_close_skips_do_not_consume_degree(db: DB, queues: AnnotationQueueRepo) -> None:
    """A skipped pair is asked-but-unanswered: never re-served, but it taught nothing, so
    it must not count towards either picture's comparison quota."""
    _seed_close_cluster(db, n=4)  # small enough that the budget outlasts the spine
    await _judge(db, 1, 2, winner="skip")
    pairs = await queues.sample_pairs(count=6, strategy="close")
    assert frozenset((1, 2)) not in {frozenset(p) for p in pairs}
    assert any(1 in p for p in pairs), "1 was only skipped, so it still owes its comparisons"


async def test_close_attaches_the_new_batch_to_the_existing_graph(db: DB, queues: AnnotationQueueRepo) -> None:
    """Consecutive batches must land in ONE component, or streaming annotation never adds up.

    The UI refills 20 pairs at a time. With a per-call graph, each refill is its own island:
    the 198 comparisons collected on 2026-08-06 came back as exactly 10 components for 10
    refills, largest holding 19.7%. What joins them is an anchor drawn from the pictures
    already judged, so a bridge has something in the history to land on.
    """
    _seed_close_cluster(db, n=12)
    first = await queues.sample_pairs(count=4, strategy="close")
    for a, b in first:
        await _judge(db, a, b)
    second = await queues.sample_pairs(count=6, strategy="close")

    edges = first + second
    parent = {p: p for pair in edges for p in pair}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in edges:
        parent[find(a)] = find(b)
    assert len({find(p) for p in parent}) == 1, "第二批和第一批没连上——各自成岛"


async def test_close_never_pairs_two_copies_of_the_same_picture(db: DB, queues: AnnotationQueueRepo) -> None:
    """A repost against its original is a foregone tie, and the verdict teaches nothing.

    Measured on 3001 real verdicts: pairs at cosine >= 0.96 came back "tie" 93.7% of the
    time, and every one of the 17 such pairs the close sampler served on 2026-08-06 was a
    tie. The KNN's own near-duplicate filter does not catch this - it measures distance from
    the SEED, while close pairs members with each other.
    """
    cur = db.cursor()
    silva = {}
    for i in range(1, 7):
        cur.execute(
            "INSERT OR IGNORE INTO posts (id, file_path, file_name, extension, score) VALUES (?, ?, ?, 'png', 0)",
            [i, f"/p{i}", f"p{i}"],
        )
        vec = [0.0] * 1152
        vec[i % 1152] = 1.0
        if i in (2, 3):  # 2 and 3 are near-identical to each other, distinct from the rest
            vec = [0.0] * 1152
            vec[0] = 1.0
            vec[i] = 0.05
        cur.execute("INSERT OR REPLACE INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
                    [i, sqlite_vec.serialize_float32(vec)])
        silva[i] = 0.40 + i * 0.01
    _seed_silva(db, silva)

    pairs = await queues.sample_pairs(count=10, strategy="close")
    assert frozenset((2, 3)) not in {frozenset(p) for p in pairs}
    assert pairs, "近重复被排除后不该把整批也一起丢掉"


async def test_close_bridges_every_block_a_batch_splits_into(db: DB, queues: AnnotationQueueRepo) -> None:
    """A library with a score gap yields several blocks, and EVERY one of them needs a bridge.

    A window is one score range, so a library whose scores sit in two clusters 0.37 apart
    cannot be covered by a single block: the batch comes back as several, and connecting
    only the one holding the batch's representative leaves the rest as islands - measured
    on the real library that left the main component growing by 1 picture per batch instead
    of ~20, while the returned pair count looked exactly right.

    Both halves of the assertion matter: every picture gets scheduled, AND the whole batch
    lands in one component.
    """
    cur = db.cursor()
    silva = {}
    for i in range(1, 9):
        cur.execute(
            "INSERT OR IGNORE INTO posts (id, file_path, file_name, extension, score) VALUES (?, ?, ?, 'png', 0)",
            [i, f"/p{i}", f"p{i}"],
        )
        vec = [0.0] * 1152
        vec[i % 1152] = 1.0
        cur.execute("INSERT OR REPLACE INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
                    [i, sqlite_vec.serialize_float32(vec)])
        silva[i] = (0.40 if i <= 4 else 0.80) + i * 0.01  # two chunks, 0.37 apart
    _seed_silva(db, silva)

    pairs = await queues.sample_pairs(count=10, strategy="close")
    assert {p for pair in pairs for p in pair} >= set(range(1, 9)), "有图完全没被排上"

    parent = {p: p for pair in pairs for p in pair}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        parent[find(a)] = find(b)
    assert len({find(p) for p in parent}) == 1, "跨 band 的那半个邻域没被桥接上"


async def test_close_bounds_a_picture_that_won_everything(db: DB, queues: AnnotationQueueRepo) -> None:
    """An undefeated picture is not "the best" - it is unplaced, and needs a stronger opponent.

    Bradley-Terry has no maximum-likelihood estimate for a picture that never lost: the data
    says "above everything it met" and nothing about how far above. On the collected verdicts
    65.7% of the pictures with 2+ decisive comparisons are in that state, which is the direct
    cost of only ever pairing inside the model's own score band. The cure is a comparison
    against something the model rates CLEARLY higher - _CALIBRATION_GAP above, not beside.
    """
    cur = db.cursor()
    silva = {}
    for i in range(1, 13):
        cur.execute(
            "INSERT OR IGNORE INTO posts (id, file_path, file_name, extension, score) VALUES (?, ?, ?, 'png', 0)",
            [i, f"/p{i}", f"p{i}"],
        )
        vec = [0.0] * 1152
        vec[i % 1152] = 1.0
        cur.execute("INSERT OR REPLACE INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
                    [i, sqlite_vec.serialize_float32(vec)])
        # 1..6 sit together at ~0.40; 7..12 sit a calibration gap above them
        silva[i] = 0.40 + i * 0.01 if i <= 6 else 0.60 + (i - 7) * 0.01
    _seed_silva(db, silva)

    # post 1 beats two neighbours from its own band and has never lost
    await _judge(db, 1, 2, winner="a")
    await _judge(db, 1, 3, winner="a")

    pairs = await queues.sample_pairs(count=12, strategy="close")
    lifted = [p for p in pairs if 1 in p and abs(silva[p[0]] - silva[p[1]]) >= _CALIBRATION_GAP[0]]
    assert lifted, f"全胜的 1 号没有拿到向上的定标对 - 实际发到 {pairs}"
    for a, b in lifted:
        assert silva[a if a != 1 else b] > silva[1], "定标对手必须在它上方 - 否则界还是开的"


async def test_close_stops_spending_on_saturated_pictures(db: DB, queues: AnnotationQueueRepo) -> None:
    """Degree is a budget across the whole history, not per call: a picture that already has
    its comparisons should stop crowding out ones that have none."""
    silva = _seed_close_cluster(db, n=12)
    for partner in (2, 3, 4):
        await _judge(db, 1, partner)  # post 1 now sits at _CLOSE_PAIR_DEGREE

    pairs = await queues.sample_pairs(count=8, strategy="close")
    local = [p for p in pairs if abs(silva[p[0]] - silva[p[1]]) <= _CLOSE_PAIR_MAX_SILVA_DIFF]
    assert all(1 not in p for p in local), "已经比够 3 次的图还在吃预算"


async def test_close_moves_between_neighbourhoods_instead_of_draining_one(db: DB, queues: AnnotationQueueRepo) -> None:
    """A batch must reach both visual pockets straight away, not drain one and then the other.

    The old sampler took a KNN neighbourhood - one subject, same character, same series -
    and emptied it before starting the next, which is what "反复在非常相似的图之间跳跃"
    describes: a 20-question stretch showed 21 distinct pictures with 89.9% of consecutive
    questions reusing a picture.

    Under windows the fix is not round-robin between pockets, because a window is a SCORE
    range and both pockets sit inside this one. It is _diverse_subset: farthest-point search
    over two orthogonal pockets has to alternate between them, so a single block already
    spans both. Both assertions below follow from that construction rather than from luck -
    measured over 200 draws they hold every time, while draining one pocket first fails both.
    """
    # two visually separate neighbourhoods: 1..6 share one axis, 11..16 another
    cur = db.cursor()
    silva = {}
    for i, pid in enumerate(list(range(1, 7)) + list(range(11, 17))):
        cur.execute(
            "INSERT OR IGNORE INTO posts (id, file_path, file_name, extension, score) VALUES (?, ?, ?, 'png', 0)",
            [pid, f"/p{pid}", f"p{pid}"],
        )
        vec = [0.0] * 1152
        vec[0 if pid < 11 else 1] = 1.0  # two orthogonal pockets
        vec[pid + 100] = 0.6  # ... but distinct enough inside each pocket
        cur.execute("INSERT OR REPLACE INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
                    [pid, sqlite_vec.serialize_float32(vec)])
        silva[pid] = 0.40 + i * 0.01
    _seed_silva(db, silva)

    pairs = await queues.sample_pairs(count=8, strategy="close")
    assert len(pairs) >= 6

    def pocket(pid: int) -> int:
        return 0 if pid < 11 else 1

    early = {pocket(pid) for pair in pairs[:3] for pid in pair}
    assert early == {0, 1}, f"开头三题还困在同一个题材里 {pairs}"
    assert any(pocket(a) != pocket(b) for a, b in pairs), f"没有一题是跨题材比较的 {pairs}"


async def test_close_pairs_are_connected_at_every_prefix(db: DB, queues: AnnotationQueueRepo) -> None:
    """Bridges must be interleaved, not appended, because a queue is served in position
    order and the annotator stops whenever they like.

    Appended bridges are exactly the edges a half-finished round never reaches, so it would
    come back as one island per cluster - the pathology the degree work exists to prevent.
    Hence the assertion is that EVERY prefix is connected, not just the whole round.
    """
    _seed_close_cluster(db, n=12)
    pairs = await queues.sample_pairs(count=18, strategy="close")
    assert len(pairs) >= 6

    for cut in range(2, len(pairs) + 1):
        prefix = pairs[:cut]
        parent = {p: p for pair in prefix for p in pair}

        def find(x: int, parent: dict[int, int] = parent) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b in prefix:
            parent[find(a)] = find(b)
        assert len({find(p) for p in parent}) == 1, f"前 {cut} 条边就已经分裂成孤岛"
