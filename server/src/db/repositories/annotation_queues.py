"""Annotation queue repository: what to annotate next, sampled from data we own.

Queues are write-once item lists (absolute posts or pairwise pairs); the UI
consumes them in position order and marks items done as judgements land.
Sampling is self-contained — it runs on the old manual score, SigLIP2
embeddings and prior annotation events — so pictoria owns the whole annotation
loop and downstream consumers just *read* the collected events.
"""

from __future__ import annotations

import asyncio
import heapq
import json
from collections import Counter
from typing import TYPE_CHECKING, Any

from db.asyncbridge import in_thread
from db.entities import AnnotationQueue
from db.helpers import fetch_all_dicts, fetch_one_as, sql_placeholders
from db.repositories.vectors import VectorRepo
from db.scorers import AESTHETIC_SCORES_TABLE, SILVA

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterable, Iterator, Sequence

QUEUE_COLUMNS = "id, name, kind, dimensions, scale, created_at"
_ITEM_TABLES = {"absolute": "absolute_queue_items", "pairwise": "pairwise_queue_items"}
_POST_COLS = ("id", "file_path", "file_name", "extension", "sha256", "width", "height")

# Tunables for the ``similar`` pairwise strategy (see ``_sample_pairs_similar``).
# 24 = floor(_SIMILAR_KNN_K / 2), i.e. one neighbourhood harvested dry. ``similar`` pairs
# strictly disjointly, so 24 is the topological ceiling — anything higher just forces
# another KNN. The old value of 8 left two thirds of each neighbourhood on the floor and
# made a 20-pair batch cost 3 KNN scans (~3.5s measured on the 214k library) where 1 does;
# ``close`` was already raised to 48 for exactly this reason. ``similar`` is no longer the
# UI default but it is the model-agnostic eval sampler, so it stays on the same footing.
_SIMILAR_PAIRS_PER_CLUSTER = 24  # disjoint pairs harvested from one KNN neighbourhood
_SIMILAR_KNN_K = 48  # neighbours fetched per seed (includes the seed itself)
_SIMILAR_MIN_DISTANCE = 0.04  # drop near-duplicates: a near-identical pair is a foregone tie
_SIMILAR_SCORE_BAND = 1  # |score_a - score_b| <= band -> same or adjacent score bucket

# Tunable for the ``close`` pairwise strategy (see ``_sample_pairs_close``): ceiling on the
# SILVA head's |calibrated_score_a - calibrated_score_b|. <= 0.10 keeps only pairs the model
# itself can't separate (directional accuracy ~0.51-0.64 there) — the boundary pairs that
# carry the preference signal absolute labels can't teach. ~36% of random pairs fall under it.
_CLOSE_PAIR_MAX_SILVA_DIFF = 0.10

# Cosine above which the two pictures are the same picture and the verdict is a foregone
# tie. Measured on 3001 real ``overall`` verdicts, tie rate by cosine:
#
#   >= 0.96      93.7%   <- no information; the answer is decided before you look
#   0.94-0.96    70.6%
#   0.90-0.94    39.5%
#   <  0.90      ~22%    (baseline)
#
# ``_SIMILAR_MIN_DISTANCE`` does NOT cover this, and neither strategy was safe without it.
# That filter runs on the KNN result, which measures distance from the SEED — while both
# ``similar`` and ``close`` pair members with each OTHER, never with the seed. Two members
# a comfortable distance from the seed can still be reposts of one another. 6.0% of the
# pairs the close sampler served on 2026-08-06 sat at cosine >= 0.96, and every one of them
# came back "tie".
#
# 0.94 rather than 0.96: the 0.94-0.96 band is 70% ties, so it costs ~5% of the budget to
# drop and buys back comparisons that can actually be decided.
_MAX_PAIR_COSINE = 0.94

# How many comparisons each picture should take part in. A preference model infers a
# global order from CHAINS — a>b, b>c ⇒ a>c — so a picture judged once contributes an
# isolated edge and no chain. Measured on the first 2726 ``overall`` annotations, which
# were collected while pairing was strictly disjoint: 5260 pictures, 96.5% of them
# compared exactly once, and the resulting training signal was "mildly positive but not
# significant". 3 is the practical floor for a graph that both connects and tolerates a
# noisy verdict; the cost is that a round of N comparisons now covers ~2N/3 pictures
# instead of 2N, which is the trade that makes those comparisons rankable at all.
_CLOSE_PAIR_DEGREE = 3

# Members drawn from ONE silva window, and how many candidates that window offers up to
# choose them from.
#
# A window is the unit ``close`` samples in, and it replaces the KNN neighbourhood that used
# to be. The neighbourhood was the wrong unit twice over. It is ONE SUBJECT — same
# character, same series, same artist — so a batch drawn from it showed 21 distinct pictures
# over 20 questions with 89.9% of consecutive questions reusing a picture. And measured on
# the collected verdicts, the pairs it produced sit at cosine 0.86 (median) against 0.69 for
# random pairs, where the tie rate is 28.2% instead of 15.1%: visually alike is precisely
# where the rater cannot call it.
#
# A window inverts that. Membership is decided by the silva score alone — every pair inside
# it is in-band by construction, so no sorting or spine is needed — and the members are then
# chosen to be as visually UNLIKE each other as the window allows (see _diverse_subset).
# That is also what the head being trained needs: it learns ``θ = wᵀφ``, whose information
# matrix is built from the differences ``φ_a - φ_b``, and differences drawn from one
# neighbourhood span a low-dimensional slice of feature space, leaving w unconstrained
# everywhere else.
#
# 6 members because they are linked into a cycle (see _window_block): 6 members, 6 edges,
# every picture at degree 2, one cycle per block. Candidates at 32 give the farthest-point
# search room to actually spread out while the 32×1152 dot products stay in the microseconds.
#
# The KNN is gone with the neighbourhood — a window is one indexed range scan rather than a
# brute-force vec0 scan, so a 20-pair refill drops from ~4s to milliseconds.
_CLOSE_BLOCK_MEMBERS = 6
_CLOSE_WINDOW_CANDIDATES = 32

# Of a block's members, how many are drawn from pictures ALREADY in the comparison graph
# rather than from the library at large (see _revisit_seeds).
#
# 2 of 6, so a block is a cycle running through two existing nodes and four new ones. Both
# halves are load-bearing and they trade against each other: every seed is a picture that
# gains two edges and, at degree 1, lands exactly on _CLOSE_PAIR_DEGREE — but it is also a
# picture this batch does not cover for the first time. At 2 a 20-pair refill still reaches
# ~8-10 new pictures while closing cycles through the graph it already has, which measured
# on a real refill it did not do at all: 13 of 19 pictures were brand new and only 5 of 20
# edges joined two already-judged pictures, all of those by chance rather than by design.
_CLOSE_REVISIT_MEMBERS = 2

# Window centres drawn per BATCH (see _window_seeds), which is a different question from
# how many candidates one window offers — the draw that produces them is a full scan
# whatever its LIMIT, so it is sized to outlast a batch's windows rather than to feed one.
_CLOSE_SEED_DRAW = 32

# Structural facts rather than tunables — everything above this line is a measurement, these
# two are arithmetic. A comparison takes two pictures; the smallest cycle takes three. A
# block of two members is therefore one comparison, not a cycle: closing it would ask the
# same question twice.
_PAIR_MEMBERS = 2
_MIN_CYCLE_MEMBERS = 3

# Already-judged pictures re-drawn as bridgeheads, so this batch attaches to the comparison
# graph you have ALREADY built instead of starting a fresh island.
#
# This is what makes streaming annotation add up. The UI refills 20 pairs at a time, which
# is ~1 KNN neighbourhood, so without an anchor every refill is a separate component: the
# 198 comparisons collected on 2026-08-06 came back as exactly 10 components, one per
# refill, with the largest holding 19.7% of the pictures. Degree alone cannot fix that —
# it connects a neighbourhood internally and says nothing about neighbourhood-to-
# neighbourhood. 2 anchors rather than 1 because a bridge can be skipped, and one skipped
# edge should not detach the whole batch.
_CLOSE_ANCHORS = 2
# Anchor candidates shortlisted from the main component before the random draw. Bounded
# because it becomes a bound-variable list, and because the shortlist is ordered by degree:
# past a couple of hundred the extras are all pictures with more comparisons than the ones
# already in it, which is the opposite of what an anchor should be.
_ANCHOR_CANDIDATES = 200

# Comparisons spent BOUNDING a picture rather than placing it, and the score offset used.
#
# A picture that won every comparison it took part in has an unbounded Bradley-Terry
# estimate: the likelihood keeps rising as its rating goes to infinity, because the data
# only ever says "above everything it met". Same, mirrored, for one that lost every time.
# On the collected verdicts 65.7% of the pictures with 2+ decisive comparisons are in
# exactly that state — 36.0% undefeated, 29.7% winless — which is not an accident but the
# direct cost of ``_CLOSE_PAIR_MAX_SILVA_DIFF``: a picture only ever meets others the model
# scores the same, so anything genuinely better than its band sweeps it.
#
# The cure is one comparison against a picture the model puts clearly ABOVE it (or below,
# for a winless one). Offset measured against the same 3248 verdicts:
#
#   gap            tie     model right
#   0.00-0.05    29.2%      53.1%   <- chance; cannot bound anything
#   0.15-0.25    23.1%      75.4%   <- decisive enough to bound, uncertain enough to matter
#   0.40+         5.8%      95.9%   <- foregone
_CALIBRATION_GAP = (0.15, 0.25)
_CALIBRATION_SHARE = 0.2  # of a batch, when there is demand for it
_CALIBRATION_MIN_DECISIVE = 2  # one verdict is not a sweep


Block = tuple[list[tuple[int, int]], tuple[int, float]]
"""Edges that already hang together, plus the ``(post_id, score)`` other blocks bridge onto."""


def _components(edges: Iterable[tuple[int, int]]) -> dict[int, set[int]]:
    """``root -> members`` for the connected components of an undirected edge list."""
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in edges:
        parent[find(a)] = find(b)
    groups: dict[int, set[int]] = {}
    for pid in parent:
        groups.setdefault(find(pid), set()).add(pid)
    return groups


def _cycle(members: list[int]) -> Iterator[tuple[int, int]]:
    """Consecutive pairs closing back onto the first — ``m`` members, ``m`` edges.

    A cycle rather than the path this used to lay down. Both connect the block, but for the
    same number of edges the path leaves its two ends at degree 1 and contains no cycle,
    while this gives every member degree 2 and closes one loop. Redundancy is the whole
    point of the extra edge: a loop is the only place a contradictory verdict can show up as
    a contradiction, and measured over the collected history only 4.2% of edges sat on any
    cycle at all.

    Members need no sorting. They come from one silva window, so EVERY pair among them is
    inside the band by construction — which is what makes the order free to be chosen for
    something else (see :meth:`AnnotationQueueRepo._diverse_subset`).
    """
    if len(members) < _PAIR_MEMBERS:
        return
    if len(members) == _PAIR_MEMBERS:
        yield members[0], members[1]
        return
    for i, a in enumerate(members):
        yield a, members[(i + 1) % len(members)]


def _connected_blocks(edges: list[tuple[int, int]], score: float) -> list[Block]:
    """Split one window's edges into the chunks that are actually connected.

    Usually there is exactly one, and that is by construction rather than by luck: a cycle
    survives losing any single edge as a path, and :func:`_cycle` emits in chain order so
    ``[:cap]`` truncates to a prefix, which is connected too. What this guards is the case
    those two do not cover — TWO of the window's edges coming back already-asked from
    :meth:`_PairGraph.claim`, which cuts the cycle into separate arcs.

    That is rare, not impossible: it needs two members drawn from a 214k library to have been
    compared before, in the adjacent positions the draw happened to give them. Rare enough
    that a synthetic fixture never hits it, common enough on a real library with thousands of
    judged pictures. Handing the bridging pass a single representative for a broken cycle
    means only the arc holding it joins the graph and the other stays an island — silently,
    since the batch is still the right size. Bridging each arc separately is what makes "one
    connected batch" true rather than intended.

    ``score`` is the window's centre, shared by every chunk: all members are within half a
    band of it, which is finer than the sort in :meth:`_interleave_with_bridges` can use.

    Within a chunk the edges are re-ordered breadth-first, and the representative is an
    endpoint of the FIRST one. Both are what let :meth:`_interleave_with_bridges` alternate
    between blocks without breaking connectivity: the bridge onto a block lands on a picture
    that block's first edge also touches, and every later edge of the block touches one
    already emitted.
    """
    by_root: dict[int, list[tuple[int, int]]] = {}
    root_of = {pid: root for root, members in _components(edges).items() for pid in members}
    for edge in edges:
        by_root.setdefault(root_of[edge[0]], []).append(edge)
    blocks: list[Block] = []
    for chunk in by_root.values():
        ordered = _breadth_first(chunk)
        blocks.append((ordered, (ordered[0][0], score)))
    return blocks


def _breadth_first(edges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Re-order a connected edge list so every edge touches a picture an earlier one used."""
    remaining = list(edges)
    ordered = [remaining.pop(0)]
    seen = set(ordered[0])
    while remaining:
        nxt = next((e for e in remaining if seen & set(e)), remaining[0])
        remaining.remove(nxt)
        ordered.append(nxt)
        seen.update(nxt)
    return ordered


class _PairGraph:
    """Edge bookkeeping for one sampling round: what has been asked, and how often each
    picture has been used.

    Exists so the pairing passes and the bridging pass share one notion of "spent" instead
    of each carrying ``out`` / ``emitted`` / ``degrees`` / ``cap`` as loose arguments.
    ``saturated`` is maintained incrementally rather than rebuilt from ``degrees`` per seed.
    """

    def __init__(self, degree: int) -> None:
        self.degree = degree
        self.degrees: Counter[int] = Counter()
        self.emitted: set[frozenset[int]] = set()
        self.saturated: set[int] = set()
        # Decisive record per picture, for spotting the ones whose rating is unbounded.
        self.wins: Counter[int] = Counter()
        self.losses: Counter[int] = Counter()
        # Largest connected component of ``emitted`` as loaded from history — the part of
        # the graph worth growing, since a ranking can only be inferred inside a component.
        # Deliberately NOT updated by :meth:`claim`: it describes what was already collected,
        # which is what the next batch has to attach to.
        self.component: set[int] = set()

    def main_component(self) -> set[int]:
        """Members of the largest connected component of ``emitted``."""
        groups = _components(tuple(edge) for edge in self.emitted)  # type: ignore[misc]
        return max(groups.values(), key=len, default=set())

    def spent(self, pid: int) -> bool:
        return self.degrees[pid] >= self.degree

    def unbounded(self, pid: int) -> int:
        """``+1`` if ``pid`` has never lost, ``-1`` if it has never won, ``0`` otherwise.

        The sign is the direction its next opponent should lie in. Only meaningful once the
        picture has :data:`_CALIBRATION_MIN_DECISIVE` decisive verdicts — a single win says
        nothing about a sweep. Ties do not count either way: a tie bounds the rating from
        both sides at once, which is precisely what these pictures are missing.
        """
        wins, losses = self.wins[pid], self.losses[pid]
        if wins + losses < _CALIBRATION_MIN_DECISIVE:
            return 0
        if not losses:
            return 1
        return -1 if not wins else 0

    def claim(self, a: int, b: int) -> tuple[int, int] | None:
        """Record the comparison, or ``None`` if it is a self-pair or already asked."""
        key = frozenset((a, b))
        if a == b or key in self.emitted:
            return None
        self.emitted.add(key)
        for pid in (a, b):
            self.degrees[pid] += 1
            if self.spent(pid):
                self.saturated.add(pid)
        return (a, b)


def _aliased_post_cols(table_alias: str, out_prefix: str) -> str:
    """``pa.id AS a_post_id, pa.file_path AS a_file_path, ...`` column list."""
    parts = [f"{table_alias}.id AS {out_prefix}post_id"]
    parts += [f"{table_alias}.{c} AS {out_prefix}{c}" for c in _POST_COLS[1:]]
    return ", ".join(parts)


class AnnotationQueueRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur
        # Sampling reuses VectorRepo's sync cores (exists_sync / knn_sync) for
        # its vec0 lookups; the sampling code already runs inside
        # ``asyncio.to_thread``, so calling them directly is correct.
        self._vectors = VectorRepo(cur)

    @in_thread
    def create_absolute_queue(self, *, name: str, dimensions: list[str], scale: int, post_ids: list[int]) -> int:
        self.cur.execute(
            "INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'absolute', ?, ?)",
            [name, json.dumps(dimensions), scale],
        )
        qid = int(self.cur.lastrowid or 0)
        self.cur.executemany(
            "INSERT INTO absolute_queue_items (queue_id, position, post_id) VALUES (?, ?, ?)",
            [(qid, pos, pid) for pos, pid in enumerate(post_ids)],
        )
        return qid

    @in_thread
    def create_pairwise_queue(self, *, name: str, dimensions: list[str], pairs: list[tuple[int, int]]) -> int:
        self.cur.execute(
            "INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'pairwise', ?, NULL)",
            [name, json.dumps(dimensions)],
        )
        qid = int(self.cur.lastrowid or 0)
        self.cur.executemany(
            "INSERT INTO pairwise_queue_items (queue_id, position, post_a, post_b) VALUES (?, ?, ?, ?)",
            [(qid, pos, a, b) for pos, (a, b) in enumerate(pairs)],
        )
        return qid

    @in_thread
    def get(self, queue_id: int) -> AnnotationQueue | None:
        self.cur.execute(
            f"SELECT {QUEUE_COLUMNS} FROM annotation_queues WHERE id = ?",  # noqa: S608
            [queue_id],
        )
        return fetch_one_as(self.cur, AnnotationQueue)

    @in_thread
    def list_queues(self) -> list[tuple[AnnotationQueue, int, int]]:
        """Return ``(queue, total_items, done_items)`` for every queue, newest first."""
        self.cur.execute(f"SELECT {QUEUE_COLUMNS} FROM annotation_queues ORDER BY id DESC")  # noqa: S608
        queues = [AnnotationQueue.model_validate(row) for row in fetch_all_dicts(self.cur)]
        # Two grouped counts (one per item table) instead of one query per queue.
        # ``_ITEM_TABLES`` is a code-level allowlist, so the names are safe to
        # interpolate; the queue list is short today but this is on the annotation
        # landing page and grows with every generated queue.
        progress: dict[tuple[str, int], tuple[int, int]] = {}
        for kind, table in _ITEM_TABLES.items():
            self.cur.execute(
                f"SELECT queue_id, COUNT(*), COALESCE(SUM(done), 0) FROM {table} GROUP BY queue_id",  # noqa: S608
            )
            for queue_id, total, done in self.cur.fetchall():
                progress[(kind, queue_id)] = (int(total), int(done))
        return [(q, *progress.get((q.kind, q.id), (0, 0))) for q in queues]

    @in_thread
    def next_absolute_items(self, queue_id: int, *, limit: int = 20) -> list[dict[str, Any]]:
        self.cur.execute(
            "SELECT i.position, p.id AS post_id, p.file_path, p.file_name, p.extension, p.sha256, p.width, p.height "
            "FROM absolute_queue_items i JOIN posts p ON p.id = i.post_id "
            "WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?",
            [queue_id, limit],
        )
        return fetch_all_dicts(self.cur)

    @in_thread
    def next_pairwise_items(self, queue_id: int, *, limit: int = 20) -> list[dict[str, Any]]:
        self.cur.execute(
            f"SELECT i.position, {_aliased_post_cols('pa', 'a_')}, {_aliased_post_cols('pb', 'b_')} "  # noqa: S608
            "FROM pairwise_queue_items i "
            "JOIN posts pa ON pa.id = i.post_a JOIN posts pb ON pb.id = i.post_b "
            "WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?",
            [queue_id, limit],
        )
        return fetch_all_dicts(self.cur)

    # ─── Sampling (queue auto-generation / streaming) ─────────────────
    #
    # Strategies run entirely on data pictoria already owns (old manual
    # score, embeddings, annotation events) — no external sampler needed.
    # Candidates must have an embedding (training joins it later), must not
    # be hidden near-duplicates, must not already be annotated in any of the
    # requested dimensions, and must not sit in an undone queue item.
    #
    # Performance: the embedding check is a vec0 virtual-table lookup, which
    # is NOT a cheap B-tree probe — putting it in the WHERE clause makes
    # SQLite run it once per posts row (~100k lookups, tens of seconds).
    # So sampling is two-phase: draw an oversized random candidate batch on
    # plain-table predicates only, then vec0-filter just that small batch.

    _CANDIDATE_WHERE = (
        "p.canonical_post_id IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM absolute_queue_items i WHERE i.post_id = p.id AND i.done = 0) "
        "AND NOT EXISTS (SELECT 1 FROM absolute_annotations a WHERE a.post_id = p.id AND a.dimension IN ({dims}))"
    )

    # Pairwise eligibility: canonical (no hidden near-dups) and not already
    # sitting in an undone pairwise queue item. Shared by both strategies.
    _PAIRWISE_ELIGIBLE = (
        "p.canonical_post_id IS NULL AND NOT EXISTS (SELECT 1 FROM pairwise_queue_items i WHERE (i.post_a = p.id OR i.post_b = p.id) AND i.done = 0)"
    )

    # ``(id, silva score)`` of the pictures still worth comparing. Four of the ``close``
    # sampling queries are this exact statement plus a tail — a score range, an id list —
    # and their own LIMIT, so the join and the eligibility clause live here once instead of
    # being hand-copied with the scorer name baked in four times. Neither half binds a
    # parameter, which is what lets every caller append its own without an offset to track.
    _SILVA_ELIGIBLE = (
        f"SELECT p.id, s.score FROM posts p "  # noqa: S608
        f"JOIN {AESTHETIC_SCORES_TABLE} s ON s.post_id = p.id AND s.scorer = '{SILVA.name}' "
        f"WHERE {_PAIRWISE_ELIGIBLE}"
    )

    def _with_embedding(self, ids: list[int]) -> list[int]:
        """Keep only ids that have a SigLIP2 embedding, preserving draw order.

        One set-based vec0 lookup rather than a probe per id: at ~1.5ms each the
        per-id form cost 1.2s of the ``generate-pairwise count=200`` request
        before any pairing happened (see ``VectorRepo.existing_sync``).
        """
        embedded = self._vectors.existing_sync(ids)
        return [pid for pid in ids if pid in embedded]

    def _draw(self, *, extra_where: str, extra_params: list[Any], dimensions: list[str], n: int) -> list[int]:
        """Phase 1: random candidates on plain predicates; phase 2: vec0 filter.

        Oversamples 2x — the library's embedding coverage is near-total, so a
        single oversized draw is enough (no refill loop, YAGNI).
        """
        dims_ph = sql_placeholders(dimensions)
        where = self._CANDIDATE_WHERE.format(dims=dims_ph)
        self.cur.execute(
            f"SELECT p.id FROM posts p WHERE {where} {extra_where} ORDER BY RANDOM() LIMIT ?",  # noqa: S608
            [*dimensions, *extra_params, n * 2],
        )
        candidates = [row[0] for row in self.cur.fetchall()]
        return self._with_embedding(candidates)[:n]

    @in_thread
    def sample_post_ids(self, *, count: int, strategy: str, dimensions: list[str]) -> list[int]:
        """Sample candidate post ids for absolute annotation."""
        if strategy == "stratified":
            # Even split across old manual score levels 1..5, random within
            # each level; top up with random candidates if levels run dry.
            per_level = max(1, count // 5)
            picked: list[int] = []
            for level in range(1, 6):
                picked += self._draw(extra_where="AND p.score = ?", extra_params=[level], dimensions=dimensions, n=per_level)
                if len(picked) >= count:
                    return picked[:count]
            fill = count - len(picked)
            if fill > 0:
                # Omit the NOT IN clause entirely when nothing was picked:
                # ``id NOT IN (NULL)`` is NULL for every row under SQL
                # three-valued logic, which silently excluded *everything*
                # and returned an empty fill on all-unscored libraries.
                not_in = f"AND p.id NOT IN ({sql_placeholders(picked)})" if picked else ""
                picked += self._draw(extra_where=not_in, extra_params=list(picked), dimensions=dimensions, n=fill)
            return picked
        return self._draw(extra_where="", extra_params=[], dimensions=dimensions, n=count)

    async def sample_pairs(self, *, count: int, strategy: str = "random", dimension: str = "overall") -> list[tuple[int, int]]:
        """Sample disjoint pairs for pairwise annotation.

        ``random``  — arbitrary disjoint pairs (fast, model-agnostic baseline).
        ``similar`` — content-similar (SigLIP2 KNN) *and* old-score-band pairs:
        comparable so the verdict is fair (like-with-like, not portrait-vs-
        landscape), close-in-score so it carries information (a 5-vs-1 verdict
        is foregone and wastes a label). The band keys off the *human* old
        score, not a model output, so the collected data stays model-agnostic.
        ``close``   — content-similar (same KNN) but paired by the SILVA model's
        score gap instead of the human band: deliberately model-AWARE sampling that
        concentrates labels on the boundary pairs the head can't resolve (the only
        comparisons that carry signal absolute labels can't). Use ``close`` to harvest
        training fuel; keep ``random``/``similar`` for model-agnostic held-out eval.

        ``dimension`` selects the comparison history ``close`` builds on: it never re-asks
        a pair judged there, and it attaches this batch to that graph rather than starting
        a fresh island.
        """
        if strategy == "similar":
            return await asyncio.to_thread(self._sample_pairs_similar, count)
        if strategy == "close":
            return await asyncio.to_thread(self._sample_pairs_close, count, dimension)

        def _impl() -> list[tuple[int, int]]:
            self.cur.execute(
                f"SELECT p.id FROM posts p WHERE {self._PAIRWISE_ELIGIBLE} ORDER BY RANDOM() LIMIT ?",  # noqa: S608
                [count * 4],
            )
            candidates = [row[0] for row in self.cur.fetchall()]
            ids = self._with_embedding(candidates)[: count * 2]
            return [(ids[i], ids[i + 1]) for i in range(0, len(ids) - 1, 2)]

        return await asyncio.to_thread(_impl)

    # ─── Similar-pair sampling (content-similar + old-score band) ─────
    #
    # A single vec0 KNN over the whole library is ~1.5s (brute-force scan, no
    # ANN index), so we can't afford one KNN per pair. Instead each KNN pulls a
    # seed's neighbourhood and we harvest several disjoint pairs from it:
    # PAIRS_PER_CLUSTER trades batch latency (~1.5s * ceil(count / PPC)) against
    # how many pairs share one visual neighbourhood inside a batch.

    def _sample_pairs_similar(self, count: int) -> list[tuple[int, int]]:
        clusters = max(1, -(-count // _SIMILAR_PAIRS_PER_CLUSTER))  # ceil(count / PPC)
        # Oversample seeds: a seed may have been consumed as an earlier
        # cluster's neighbour, or sit in a region with no in-band partner.
        self.cur.execute(
            f"SELECT p.id FROM posts p WHERE {self._PAIRWISE_ELIGIBLE} ORDER BY RANDOM() LIMIT ?",  # noqa: S608
            [clusters * 4],
        )
        seeds = [row[0] for row in self.cur.fetchall()]
        used: set[int] = set()
        pairs: list[tuple[int, int]] = []
        for seed in seeds:
            if len(pairs) >= count:
                break
            if seed in used:
                continue
            # _pair_by_score_band tolerates a lone-seed cluster (returns []),
            # so no member-count guard is needed here.
            members = self._similar_cluster(seed, used)  # `similar` stays strictly disjoint
            cap = min(_SIMILAR_PAIRS_PER_CLUSTER, count - len(pairs))
            pairs.extend(self._pair_by_score_band(members, used, cap))
            used.add(seed)  # consumed as a centre — don't re-draw or re-pair it
        return pairs[:count]

    def _similar_cluster(self, seed: int, exclude: set[int]) -> list[tuple[int, int | None]]:
        """``(id, score)`` of eligible posts in ``seed``'s KNN neighbourhood.

        Includes ``seed`` itself; drops near-duplicates (a near-identical pair
        is a foregone tie), ids in ``exclude``, and ids failing pairwise
        eligibility. Returns ``[]`` when ``seed`` has no embedding —
        ``knn_sync`` short-circuits then (vec0's MATCH rejects a NULL query
        vector with a hard error).

        ``exclude`` is what each strategy considers spent: ``similar`` passes the
        already-paired ids (strictly disjoint), ``close`` passes only the ids that have
        reached :data:`_CLOSE_PAIR_DEGREE`, so a picture can recur across neighbourhoods
        and stitch them into one comparison graph.
        """
        knn = self._vectors.knn_sync(seed, _SIMILAR_KNN_K)
        if not knn:
            return []
        member_ids = [seed]
        member_ids += [pid for pid, dist in knn if pid != seed and dist >= _SIMILAR_MIN_DISTANCE and pid not in exclude]
        ph = sql_placeholders(member_ids)
        self.cur.execute(
            f"SELECT p.id, p.score FROM posts p WHERE p.id IN ({ph}) AND {self._PAIRWISE_ELIGIBLE}",  # noqa: S608
            member_ids,
        )
        return list(self.cur.fetchall())

    def _pair_by_score_band(self, members: list[tuple[int, int | None]], used: set[int], cap: int) -> list[tuple[int, int]]:
        """Greedily pair cluster members into disjoint same/adjacent-score pairs.

        Scored members (old score >= 1) sort by score and pair with their
        nearest-in-score neighbour — consecutive-in-sorted is the smallest
        possible gap; a pair is rejected (and the lower member stranded) only
        when even that gap exceeds the band, so a score-isolated image is never
        forced into a foregone 5-vs-1. Unscored members (score 0 = never rated)
        share one bucket and pair off freely: their quality is unknown, so any
        same-content pair is a fair, informative comparison. ``used`` is mutated
        as pairs are claimed, keeping the whole batch disjoint.

        Pairs closer than :data:`_MAX_PAIR_COSINE` are dropped for the same reason
        they are in ``close``: the KNN filter only measures distance from the seed, so two
        of its neighbours can still be copies of one another, and that verdict is a tie
        before you look at it.
        """
        member_ids = [pid for pid, _ in members]
        unit = self._vectors.unit_vectors_sync(member_ids)

        def too_alike(a: int, b: int) -> bool:
            return a in unit and b in unit and float(unit[a] @ unit[b]) >= _MAX_PAIR_COSINE

        out: list[tuple[int, int]] = []
        scored = sorted(((pid, s) for pid, s in members if s and pid not in used), key=lambda t: t[1])
        i = 0
        while i + 1 < len(scored) and len(out) < cap:
            (a, sa), (b, sb) = scored[i], scored[i + 1]
            if abs(sa - sb) <= _SIMILAR_SCORE_BAND and not too_alike(a, b):
                out.append((a, b))
                used.update((a, b))
                i += 2
            else:
                i += 1  # `a` has no usable partner among the higher scores
        unscored = [pid for pid, s in members if not s and pid not in used]
        for j in range(0, len(unscored) - 1, 2):
            if len(out) >= cap:
                break
            a, b = unscored[j], unscored[j + 1]
            if too_alike(a, b):
                continue
            out.append((a, b))
            used.update((a, b))
        return out

    # ─── Close-pair sampling (content-similar + SILVA model-score band) ───
    #
    # Same KNN neighbourhood harvesting as ``_sample_pairs_similar`` but paired by the
    # SILVA head's score gap, not the human old-score band — model-AWARE on purpose, to
    # concentrate labels on the boundary pairs the head can't separate.

    def _load_silva_scores(self, ids: list[int]) -> dict[int, float]:
        """``post_id -> SILVA calibrated_score`` for ``ids`` (ids with no score dropped)."""
        if not ids:
            return {}
        ph = sql_placeholders(ids)
        self.cur.execute(
            f"SELECT post_id, score FROM {AESTHETIC_SCORES_TABLE} WHERE scorer = ? AND post_id IN ({ph})",  # noqa: S608
            [SILVA.name, *ids],
        )
        return dict(self.cur.fetchall())

    def _diverse_subset(self, candidates: list[int], target: int, seeds: Sequence[int] = ()) -> list[int]:
        """The most visually spread-out ``target`` of ``candidates``, by SigLIP2 cosine.

        ``seeds`` are members the block must contain — they take their slots unconditionally
        and the greedy search fills the rest around them, so it spreads away from what is
        already in rather than starting over. That is what gives the re-visit pool
        (:meth:`_revisit_seeds`) a guaranteed place in the cycle instead of a lottery ticket
        among 96 candidates. With no seeds this is the plain farthest-point search it was.

        A silva window already says its members are equally good; it says nothing about
        whether they look alike, and left alone a window drawn from a 214k library will hand
        back whatever happens to be in that score range. Choosing the spread-out subset is
        what makes the differences ``φ_a - φ_b`` span the feature space rather than collapse
        into one visual pocket's directions — and those differences are exactly what the
        head trained on these comparisons is identified by.

        It also buys back verdicts. Over the collected history the tie rate runs 28.2% at
        cosine 0.85-0.94 (where the old KNN sampler lived, median 0.86) against 15.1% below
        0.65: alike is where the rater cannot call it, so spread is not decoration.

        Greedy farthest-point rather than a cosine ceiling: a fixed threshold either strands
        a sparse window — no subset clears it, and nothing gets sampled from that part of the
        score range at all — or admits everything in a dense one. Max-min always returns the
        best spread the window can offer, whatever it holds. :data:`_MAX_PAIR_COSINE` still
        applies as a hard stop, because a repost of an already-picked member is a foregone
        tie no matter how much room is left.
        """
        unit = self._vectors.unit_vectors_sync([*seeds, *candidates])
        picked = [pid for pid in seeds if pid in unit][:target]
        pool = [pid for pid in candidates if pid in unit and pid not in picked]
        if not picked:
            if not pool:
                return []
            picked = [pool.pop(0)]  # candidates arrive shuffled, so the seed is already random
        worst = {pid: max(float(unit[pid] @ unit[q]) for q in picked) for pid in pool}
        while len(picked) < target and worst:
            nxt = min(worst, key=worst.__getitem__)
            if worst[nxt] >= _MAX_PAIR_COSINE:
                break  # everything left is a copy of something already picked
            picked.append(nxt)
            del worst[nxt]
            for pid, prev in worst.items():
                worst[pid] = max(prev, float(unit[pid] @ unit[nxt]))
        return picked

    def _window_seeds(self, n: int) -> list[tuple[int, float]]:
        """``(post_id, silva_score)`` of random pictures still worth comparing.

        Their scores are the centres this batch's windows are built around. Drawn from the
        pictures themselves rather than uniformly over [0, 1], so windows land where the
        library actually is instead of where the score axis is.

        Drawn ONCE per batch, not once per window. ``ORDER BY RANDOM()`` cannot stop early:
        it scans every silva row and sorts the lot in a temp B-tree whether it returns one
        row or thirty-two, which measured ~280ms on the 214k library. Per window that was the
        single most expensive thing in the sampler and it bought nothing — one draw serves
        every window in the batch for the same price.

        Nothing keeps two centres apart, and nothing needs to: overlapping windows cannot
        double-spend a picture, because :meth:`_window_candidates` filters the batch's spent
        set. The caller skips a seed that is already spent only so the centre comes from a
        picture the batch can still use, not to separate the ranges.
        """
        self.cur.execute(f"{self._SILVA_ELIGIBLE} ORDER BY RANDOM() LIMIT ?", [n])
        return list(self.cur.fetchall())

    def _window_candidates(self, centre: float, exclude: set[int]) -> list[int]:
        """Eligible pictures whose silva score is within half a band of ``centre``.

        Half a band each way, so any two members of the window are at most a full
        :data:`_CLOSE_PAIR_MAX_SILVA_DIFF` apart and every pair inside it is in-band by
        construction — no sorting, no spine, no per-edge band check.

        Over-fetches and filters ``exclude`` in Python rather than in the SQL: the exclusion
        set is the batch's spent pictures plus everything already at degree, which on the
        collected history is over a thousand ids — a bound-variable list that size is worth
        avoiding when a LIMIT three times the target costs nothing.
        """
        half = _CLOSE_PAIR_MAX_SILVA_DIFF / 2
        self.cur.execute(
            f"{self._SILVA_ELIGIBLE} AND s.score BETWEEN ? AND ? ORDER BY RANDOM() LIMIT ?",
            [centre - half, centre + half, _CLOSE_WINDOW_CANDIDATES * 3],
        )
        out = [pid for pid, _ in self.cur.fetchall() if pid not in exclude]
        return out[:_CLOSE_WINDOW_CANDIDATES]

    def _revisit_pool(self, graph: _PairGraph, dimension: str) -> dict[int, float]:
        """``post_id -> silva score`` of already-judged pictures that still want edges.

        One query per batch for the whole pool, then the per-window slice is a scan over a
        few thousand floats in memory (see :meth:`_revisit_seeds`) — a window is a score
        range, so no index could answer "judged AND in this range" any faster than that.
        """
        self.cur.execute(
            f"{self._SILVA_ELIGIBLE} AND p.id IN ("  # noqa: S608
            " SELECT post_a FROM pairwise_annotations WHERE dimension = ?"
            " UNION SELECT post_b FROM pairwise_annotations WHERE dimension = ?)",
            [dimension, dimension],
        )
        return {pid: score for pid, score in self.cur.fetchall() if not graph.spent(pid)}

    @staticmethod
    def _revisit_seeds(pool: dict[int, float], graph: _PairGraph, centre: float, exclude: set[int], n: int) -> list[int]:
        """The ``n`` least-compared judged pictures whose score falls inside this window.

        This is what makes a batch THICKEN the graph rather than only extend it. Anchors
        already attach the batch to the main component, but they contribute one bridge each
        and nothing more, so before this the only judged pictures inside a block were the
        ones a random 214k draw happened to land on — measured on a real refill, 13 of 19
        pictures were brand new and the cycles closed among pictures that had never been
        compared. Cycles are the redundancy the collected history is most short of (4.2% of
        edges sat on one), and a cycle is worth far more when it runs THROUGH the existing
        graph than beside it.

        Least-compared first, so a picture at degree 1 is preferred to one at degree 2: two
        cycle edges take the former to exactly :data:`_CLOSE_PAIR_DEGREE` rather than past it.
        """
        half = _CLOSE_PAIR_MAX_SILVA_DIFF / 2
        inside = [pid for pid, score in pool.items() if abs(score - centre) <= half and pid not in exclude]
        return heapq.nsmallest(n, inside, key=lambda pid: graph.degrees[pid])

    def _window_block(self, graph: _PairGraph, centre: float, revisit: dict[int, float], exclude: set[int], cap: int) -> list[Block]:
        """One block: a silva window's most visually diverse members, linked into a cycle.

        Part of the block is drawn from pictures already in the comparison graph
        (:meth:`_revisit_seeds`) and the rest from the library at large, so the cycle stitches
        old under-compared pictures together with new ones.

        Returns :data:`Block` s — edges plus the ``(representative, score)`` other blocks
        bridge onto — via :func:`_connected_blocks`, because a claim can come back ``None``
        for a pair already asked months ago and that breaks the cycle into arcs. Each arc
        has to be bridged separately or only the one holding the representative joins the
        graph.
        """
        # A cycle of m members carries m edges — except at m = 2, which is a single
        # comparison. So a one-edge cap wants exactly two members and anything larger wants
        # at least three: asking for `cap` members would hand back a two-member block for
        # cap = 2 and spend half the budget on nothing.
        target = _PAIR_MEMBERS if cap <= 1 else min(_CLOSE_BLOCK_MEMBERS, max(_MIN_CYCLE_MEMBERS, cap))
        seeds = self._revisit_seeds(revisit, graph, centre, exclude, min(_CLOSE_REVISIT_MEMBERS, target - 1))
        members = self._diverse_subset(self._window_candidates(centre, exclude), target, seeds)
        if len(members) < _PAIR_MEMBERS:
            return []
        exclude.update(members)
        edges = [edge for a, b in _cycle(members) if (edge := graph.claim(a, b))][:cap]
        return _connected_blocks(edges, centre) if edges else []

    def _judged_graph(self, dimension: str) -> _PairGraph:
        """The comparison graph you have already built, as the starting state of this batch.

        Sampling has to be stateful across calls or streaming annotation cannot accumulate:
        the UI asks for 20 pairs at a time, so a graph that starts empty every call gives
        each refill its own component and its own degree budget — measured on 2026-08-06,
        exactly 10 components for 10 refills.

        Reading it back makes four things true at once: a pair is never asked twice (even
        across sessions and months), a picture already compared :data:`_CLOSE_PAIR_DEGREE`
        times stops consuming budget, the pictures in between are available as bridgeheads
        for :meth:`_draw_anchors`, and the win/loss record is there for
        :meth:`_calibration_blocks` to find the ratings that are still unbounded.

        ``skip`` verdicts count as asked but not as compared — you skipped the pair for a
        reason, so it should not come back, but it produced no ordering information and
        should not fill either picture's degree quota.
        """
        graph = _PairGraph(_CLOSE_PAIR_DEGREE)
        self.cur.execute(
            "SELECT post_a, post_b, winner FROM pairwise_annotations WHERE dimension = ?",
            [dimension],
        )
        for a, b, winner in self.cur.fetchall():
            graph.emitted.add(frozenset((a, b)))
            if winner == "skip":
                continue
            if winner in ("a", "b"):
                won, lost = (a, b) if winner == "a" else (b, a)
                graph.wins[won] += 1
                graph.losses[lost] += 1
            for pid in (a, b):
                graph.degrees[pid] += 1
                if graph.spent(pid):
                    graph.saturated.add(pid)
        graph.component = graph.main_component()
        return graph

    def _draw_anchors(self, graph: _PairGraph, n: int) -> list[tuple[int, float]]:
        """``(post_id, silva_score)`` of pictures in the MAIN component to bridge onto.

        "Already judged" is not a strong enough condition. The 2026-06 history is 2488
        components for 5184 pictures, so an anchor drawn uniformly from the judged set is
        almost always a member of some isolated old edge: each refill then attaches to a
        different island and the component count climbs with every batch (measured: 2 -> 15
        across ten refills, largest component falling 90.9% -> 9.8%). Anchoring inside the
        largest component instead makes every batch extend the same graph, which is the
        only version of this that ends in a global ranking.

        Preference goes to the least-compared members of that component — they are the ones
        that still need edges, so one draw both connects the batch and thickens the graph.
        The candidate slice is capped because it becomes a bound-variable list.
        """
        pool = [pid for pid in graph.component if not graph.spent(pid)]
        if not pool:
            return []
        candidates = heapq.nsmallest(_ANCHOR_CANDIDATES, pool, key=lambda pid: graph.degrees[pid])
        self.cur.execute(
            f"{self._SILVA_ELIGIBLE} AND p.id IN ({sql_placeholders(candidates)}) ORDER BY RANDOM() LIMIT ?",
            [*candidates, n],
        )
        return list(self.cur.fetchall())

    def _calibration_blocks(self, graph: _PairGraph, budget: int) -> list[Block]:
        """One comparison each for the pictures whose rating has no upper (or lower) bound.

        A picture that has won everything it met is not "the best" — it is unplaced. The
        Bradley-Terry likelihood for it has no maximum, and nothing inside its own SILVA band
        can fix that, because the band is what produced the sweep. So its partner is drawn
        deliberately OUTSIDE the band, on the side it has never been beaten from: the winner
        of everything meets something the model rates clearly higher, the loser of everything
        something clearly lower. See :data:`_CALIBRATION_GAP` for why 0.15-0.25.

        These edges cost nothing structurally — one endpoint is already deep in the graph —
        and they pull the batch out of a single visual pocket, since the partner comes from a
        different part of the score range rather than the seed's neighbourhood.
        """
        needy = [
            (pid, direction) for pid in graph.component
            if not graph.spent(pid) and (direction := graph.unbounded(pid))
        ]
        if not needy:
            return []
        # most decisive verdicts first: those are the sweeps a bound is most overdue for
        needy.sort(key=lambda t: -(graph.wins[t[0]] + graph.losses[t[0]]))
        scores = self._load_silva_scores([pid for pid, _ in needy[: budget * 4]])

        lo, hi = _CALIBRATION_GAP
        blocks: list[Block] = []
        for pid, direction in needy:
            if len(blocks) >= budget:
                break
            if pid not in scores:
                continue
            base = scores[pid]
            window = (base + lo, base + hi) if direction > 0 else (base - hi, base - lo)
            partner = self._partner_in_window(window)
            if partner is not None and (edge := graph.claim(pid, partner)):
                blocks.append(([edge], (pid, base)))
        return blocks

    def _partner_in_window(self, window: tuple[float, float]) -> int | None:
        """An eligible picture whose SILVA score falls in ``window``, or ``None``."""
        self.cur.execute(
            f"{self._SILVA_ELIGIBLE} AND s.score BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 1",
            list(window),
        )
        row = self.cur.fetchone()
        return int(row[0]) if row else None

    def _sample_pairs_close(self, count: int, dimension: str = "overall") -> list[tuple[int, int]]:
        """Pairs the SILVA head scores close, drawn to be visually UNLIKE each other.

        Each block is one silva window (:meth:`_window_block`): its members are in-band with
        one another by construction, chosen for maximum spread in SigLIP2 space, and linked
        into a cycle. Three properties decide whether the collected comparisons are worth
        anything, and each is here:

        * **in-band** — a window is :data:`_CLOSE_PAIR_MAX_SILVA_DIFF` wide, so every edge is
          a comparison the model itself cannot call;
        * **visually spread** — the old KNN neighbourhood pinned members at cosine 0.86
          median, where 28.2% of verdicts come back "tie" and the differences ``φ_a - φ_b``
          all point the same way. Windows draw on score alone, so the members can be picked
          apart in feature space instead;
        * **accumulating** — the batch starts from the comparison graph already collected
          (:meth:`_judged_graph`), is anchored into it, and blocks are bridged to each other,
          so a streaming session that refills every 15 judgements keeps extending ONE graph
          rather than laying down a fresh island each time.
        """
        graph = self._judged_graph(dimension)
        # Anchors carry no edges of their own; they exist so a bridge lands on a picture
        # that is already in the graph. Sorting in _interleave_with_bridges places each one
        # next to the block it is closest to in score.
        blocks: list[Block] = [([], anchor) for anchor in self._draw_anchors(graph, _CLOSE_ANCHORS)]
        blocks += self._calibration_blocks(graph, max(1, round(count * _CALIBRATION_SHARE)))
        # Spent for THIS batch: a window must not re-offer a picture an earlier window took,
        # and must not spend budget on one already at degree across the whole history.
        spent = set(graph.saturated)
        revisit = self._revisit_pool(graph, dimension)
        seeds = iter(self._window_seeds(_CLOSE_SEED_DRAW))

        # Bridges have to be paid for out of ``count``, not added on top of it. ``k`` blocks
        # need ``k - 1`` bridges, and adding this block makes ``len(blocks)`` of them — so
        # that many edges are subtracted from the block's cap. Without the reservation the
        # blocks fill the budget exactly and ``out[:count]`` cuts the bridges off the end,
        # which is silent: the batch looks the right size and comes back disconnected.
        # ``> 0`` rather than ``>= 0``: a zero cap still costs a window's queries and can
        # only come back empty.
        while (cap := count - sum(len(e) for e, _ in blocks) - len(blocks)) > 0:
            centre = next((score for pid, score in seeds if pid not in spent), None)
            if centre is None:
                break  # the batch has spent every seed it drew
            harvest = self._window_block(graph, centre, revisit, spent, cap)
            if not harvest:
                break  # the library has no window left that this batch has not spent
            blocks += harvest

        return self._interleave_with_bridges(blocks, graph, count)

    @staticmethod
    def _interleave_with_bridges(blocks: list[Block], graph: _PairGraph, count: int) -> list[tuple[int, int]]:
        """Deal the blocks out ROUND-ROBIN in SILVA order, bridging each to the last.

        An anchor from the existing graph is a block with no edges of its own — it
        contributes nothing to annotate, only a place for the neighbouring blocks to bridge
        onto, which is how a batch joins the history.

        Round-robin rather than block-by-block, because a block is one KNN neighbourhood and
        emptying one before starting the next is what made annotating feel like being stuck:
        measured on the real library, a 20-question stretch showed **21 distinct pictures**
        and 89.9% of consecutive questions reused a picture from the one before. Dealing one
        edge from each block in turn moves the subject every question instead.

        Two properties this ordering keeps:

        * **Every prefix is connected.** The queue is served in position order and the
          annotator stops whenever they like, so bridges appended at the end are precisely
          the edges never reached — a half-finished round would come back as one island per
          block. It survives round-robin because a block's bridge is emitted immediately
          before that block's first edge, and both touch its representative (see
          :func:`_connected_blocks`).
        * **Bridges join the most alike neighbourhoods.** Sorting the blocks by score first
          means each bridge spans the smallest available gap, so it is a comparison the
          rater can still make rather than an arbitrary cross-link.

        Bridges are not a fixed share of the budget: connecting ``k`` blocks needs ``k - 1``
        edges and no fewer. A cap that silently dropped them would return a disconnected
        round indistinguishable from a connected one.
        """
        blocks.sort(key=lambda blk: blk[1][1])
        out: list[tuple[int, int]] = []
        for round_no in range(max((len(edges) for edges, _ in blocks), default=0)):
            for i, (edges, (rep, _)) in enumerate(blocks):
                if round_no == 0 and i and (bridge := graph.claim(blocks[i - 1][1][0], rep)):
                    out.append(bridge)
                if round_no < len(edges):
                    out.append(edges[round_no])
        return out[:count]

    @in_thread
    def posts_by_id(self, ids: list[int]) -> dict[int, dict[str, Any]]:
        """``post_id -> image row`` for the ids that still exist, duplicates collapsed.

        Every caller here renders posts it holds ids for — a sampled batch, a page of
        annotation history — and each of them needs the same seven image columns and the
        same "the post may have been deleted since" handling, so the query lives once.
        """
        unique = list(dict.fromkeys(ids))
        if not unique:
            return {}
        self.cur.execute(
            f"SELECT {_aliased_post_cols('p', '')} FROM posts p WHERE p.id IN ({sql_placeholders(unique)})",  # noqa: S608
            unique,
        )
        return {row["post_id"]: row for row in fetch_all_dicts(self.cur)}

    @in_thread
    def mark_done(self, queue_id: int, *, kind: str, position: int, done: bool = True) -> bool:
        """Flip one queue item's done flag. ``done=False`` is what undo puts back."""
        table = _ITEM_TABLES[kind]
        self.cur.execute(
            f"UPDATE {table} SET done = ? WHERE queue_id = ? AND position = ?",  # noqa: S608
            [int(done), queue_id, position],
        )
        return self.cur.rowcount > 0

    async def sample_absolute_items(self, *, count: int, strategy: str, dimensions: list[str]) -> list[dict[str, Any]]:
        """Sample candidates with image fields — queue-less streaming annotation."""
        ids = await self.sample_post_ids(count=count, strategy=strategy, dimensions=dimensions)
        if not ids:
            return []
        by_id = await self.posts_by_id(ids)
        # Draw order is the sampling order and the queue is served in it, so rebuild the
        # list from ``ids`` rather than from whatever order IN (...) returned.
        return [by_id[pid] for pid in ids if pid in by_id]

    async def sample_pairwise_items(self, *, count: int, strategy: str = "random", dimension: str = "overall") -> list[dict[str, Any]]:
        """Sample pairs with image fields for both sides — queue-less streaming.

        This is the path the UI actually uses; ``dimension`` is what lets ``close`` extend
        the graph already collected there instead of restarting it every refill.
        """
        pairs = await self.sample_pairs(count=count, strategy=strategy, dimension=dimension)
        if not pairs:
            return []

        # One fetch for every picture in the batch, then assemble the pairs in Python.
        # The per-pair query this replaces was a self-join issued once per pair — 20
        # round-trips to render one refill — and the pair ORDER is load-bearing
        # (``_interleave_with_bridges`` guarantees connectivity at every PREFIX), so it
        # has to be rebuilt from ``pairs``, not from the row order IN (...) returned.
        by_id = await self.posts_by_id([pid for pair in pairs for pid in pair])
        out: list[dict[str, Any]] = []
        for a, b in pairs:
            row_a, row_b = by_id.get(a), by_id.get(b)
            if row_a is None or row_b is None:
                continue  # post deleted between sampling and fetch
            out.append({f"a_{k}": v for k, v in row_a.items()} | {f"b_{k}": v for k, v in row_b.items()})
        return out
