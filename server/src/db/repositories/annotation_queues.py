"""Annotation queue repository: what to annotate next, sampled from data we own.

Queues are write-once item lists (absolute posts or pairwise pairs); the UI
consumes them in position order and marks items done as judgements land.
Sampling is self-contained — it runs on the old manual score, SigLIP2
embeddings and prior annotation events — so pictoria owns the whole annotation
loop and downstream consumers just *read* the collected events.
"""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from itertools import pairwise
from typing import TYPE_CHECKING, Any

from db.asyncbridge import in_thread
from db.entities import AnnotationQueue
from db.helpers import fetch_all_dicts, fetch_one_as, sql_placeholders
from db.repositories.vectors import VectorRepo

if TYPE_CHECKING:
    import sqlite3

QUEUE_COLUMNS = "id, name, kind, dimensions, scale, created_at"
_ITEM_TABLES = {"absolute": "absolute_queue_items", "pairwise": "pairwise_queue_items"}
_POST_COLS = ("id", "file_path", "file_name", "extension", "sha256", "width", "height")

# Tunables for the ``similar`` pairwise strategy (see ``_sample_pairs_similar``).
_SIMILAR_PAIRS_PER_CLUSTER = 8  # disjoint pairs harvested from one KNN neighbourhood
_SIMILAR_KNN_K = 48  # neighbours fetched per seed (includes the seed itself)
_SIMILAR_MIN_DISTANCE = 0.04  # drop near-duplicates: a near-identical pair is a foregone tie
_SIMILAR_SCORE_BAND = 1  # |score_a - score_b| <= band -> same or adjacent score bucket

# Tunable for the ``close`` pairwise strategy (see ``_sample_pairs_close``): ceiling on the
# SILVA head's |calibrated_score_a - calibrated_score_b|. <= 0.10 keeps only pairs the model
# itself can't separate (directional accuracy ~0.51-0.64 there) — the boundary pairs that
# carry the preference signal absolute labels can't teach. ~36% of random pairs fall under it.
_CLOSE_PAIR_MAX_SILVA_DIFF = 0.10

# How many comparisons each picture should take part in. A preference model infers a
# global order from CHAINS — a>b, b>c ⇒ a>c — so a picture judged once contributes an
# isolated edge and no chain. Measured on the first 2726 ``overall`` annotations, which
# were collected while pairing was strictly disjoint: 5260 pictures, 96.5% of them
# compared exactly once, and the resulting training signal was "mildly positive but not
# significant". 3 is the practical floor for a graph that both connects and tolerates a
# noisy verdict; the cost is that a round of N comparisons now covers ~2N/3 pictures
# instead of 2N, which is the trade that makes those comparisons rankable at all.
_CLOSE_PAIR_DEGREE = 3

# Share of a ``close`` round spent on BRIDGES between KNN neighbourhoods. Degree alone
# only connects a neighbourhood internally: each seed's cluster becomes its own chain, and
# on the real 108k library random seeds almost never share members, so a 200-pair round
# came out as 9 separate islands holding 12% of the pictures each. A ranking can only be
# inferred inside a component, so a handful of cross-cluster edges is not decoration — it
# is what makes the round one rankable graph instead of nine. Bridges are picked between
# the SILVA-closest representatives of adjacent clusters, so they stay as informative as
# the band allows while doing the connecting.
# Edges harvested per KNN neighbourhood. A brute-force vec0 KNN is ~1.5s on the 108k
# library and dominates the whole call, so the cap should let one neighbourhood pay for
# itself: with k=48 members at degree 3 the topology admits up to 72 edges, and 48 leaves
# headroom for the band rejecting members. The earlier value (PAIRS_PER_CLUSTER * DEGREE
# = 24) forced twice as many KNN scans for the same round.
_CLOSE_PAIRS_PER_CLUSTER = 48


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

    def spent(self, pid: int) -> bool:
        return self.degrees[pid] >= self.degree

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
        out: list[tuple[AnnotationQueue, int, int]] = []
        for q in queues:
            table = _ITEM_TABLES[q.kind]
            self.cur.execute(
                f"SELECT COUNT(*), COALESCE(SUM(done), 0) FROM {table} WHERE queue_id = ?",  # noqa: S608
                [q.id],
            )
            total, done = self.cur.fetchone()
            out.append((q, int(total), int(done)))
        return out

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

    def _with_embedding(self, ids: list[int]) -> list[int]:
        """Keep only ids that have a SigLIP2 embedding (vec0 point lookups)."""
        return [pid for pid in ids if self._vectors.exists_sync(pid)]

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

    async def sample_pairs(self, *, count: int, strategy: str = "random") -> list[tuple[int, int]]:
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
        """
        if strategy == "similar":
            return await asyncio.to_thread(self._sample_pairs_similar, count)
        if strategy == "close":
            return await asyncio.to_thread(self._sample_pairs_close, count)

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

    @staticmethod
    def _pair_by_score_band(members: list[tuple[int, int | None]], used: set[int], cap: int) -> list[tuple[int, int]]:
        """Greedily pair cluster members into disjoint same/adjacent-score pairs.

        Scored members (old score >= 1) sort by score and pair with their
        nearest-in-score neighbour — consecutive-in-sorted is the smallest
        possible gap; a pair is rejected (and the lower member stranded) only
        when even that gap exceeds the band, so a score-isolated image is never
        forced into a foregone 5-vs-1. Unscored members (score 0 = never rated)
        share one bucket and pair off freely: their quality is unknown, so any
        same-content pair is a fair, informative comparison. ``used`` is mutated
        as pairs are claimed, keeping the whole batch disjoint.
        """
        out: list[tuple[int, int]] = []
        scored = sorted(((pid, s) for pid, s in members if s and pid not in used), key=lambda t: t[1])
        i = 0
        while i + 1 < len(scored) and len(out) < cap:
            (a, sa), (b, sb) = scored[i], scored[i + 1]
            if abs(sa - sb) <= _SIMILAR_SCORE_BAND:
                out.append((a, b))
                used.update((a, b))
                i += 2
            else:
                i += 1  # `a` has no in-band partner among the higher scores
        unscored = [pid for pid, s in members if not s and pid not in used]
        for j in range(0, len(unscored) - 1, 2):
            if len(out) >= cap:
                break
            a, b = unscored[j], unscored[j + 1]
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
            f"SELECT post_id, score FROM post_aesthetic_scores WHERE scorer = 'silva' AND post_id IN ({ph})",  # noqa: S608
            ids,
        )
        return dict(self.cur.fetchall())

    def _pair_by_silva_band(
        self, member_ids: list[int], graph: _PairGraph, cap: int,
    ) -> tuple[list[tuple[int, int]], tuple[int, float] | None]:
        """Chain cluster members the SILVA head scores CLOSE into a connected sub-graph.

        Returns the edges plus the cluster's ``(representative, score)`` — its median
        member — which :meth:`_sample_pairs_close` uses to bridge this cluster to the next.
        Returning it here avoids re-reading and re-sorting the same scores later.

        Members sort by SILVA score and are linked in two passes:

        1. **Spine** — consecutive members (i, i+1). This alone is a path through the whole
           cluster, so the cluster is connected before any other edge is considered.
        2. **Thicken** — further in-band edges until each picture carries ``graph.degree``
           comparisons, giving the redundancy a noisy verdict needs.

        The order matters. Thickening greedily from the first member instead builds a
        *clique* out of the earliest few and leaves the rest untouched: with degree 3 the
        first four members saturate each other and a 12-member cluster comes out as three
        disconnected blocks of four. Connectivity has to be laid down first and decorated
        second, never inferred from a degree target.

        Every edge stays inside ``_CLOSE_PAIR_MAX_SILVA_DIFF`` — degree is not bought by
        relaxing difficulty. Members without a SILVA score are skipped.
        """
        silva = self._load_silva_scores(member_ids)
        scored = sorted(((pid, silva[pid]) for pid in member_ids if pid in silva), key=lambda t: t[1])
        if not scored:
            return [], None

        out: list[tuple[int, int]] = []

        def take(a: int, b: int) -> None:
            if len(out) < cap and (edge := graph.claim(a, b)):
                out.append(edge)

        for (a, sa), (b, sb) in pairwise(scored):  # pass 1: the spine
            if sb - sa <= _CLOSE_PAIR_MAX_SILVA_DIFF:
                take(a, b)

        for i, (a, sa) in enumerate(scored):  # pass 2: thicken to the degree target
            for j in range(i + 2, len(scored)):  # i+1 is already a spine edge
                b, sb = scored[j]
                if sb - sa > _CLOSE_PAIR_MAX_SILVA_DIFF or graph.spent(a):
                    break  # sorted: every later member is further still
                if not graph.spent(b):
                    take(a, b)
        return out, scored[len(scored) // 2]

    def _sample_pairs_close(self, count: int) -> list[tuple[int, int]]:
        """Visually-similar (KNN) pairs the SILVA head scores close — the boundary pairs.

        Same per-seed neighbourhood harvesting as ``_sample_pairs_similar``, but pairs via
        :meth:`_pair_by_silva_band` (model score gap) instead of the human old-score band,
        with two changes that decide whether the round is rankable at all:

        * each picture is compared :data:`_CLOSE_PAIR_DEGREE` times rather than once, so a
          neighbourhood yields a chain instead of a matching;
        * the neighbourhoods are then linked to each other — chains that never meet still
          cannot be ranked against one another. On the real library random seeds share
          almost no members, so without this a round comes back as one island per seed.
        """
        clusters = max(1, -(-count // _CLOSE_PAIRS_PER_CLUSTER))
        self.cur.execute(
            f"SELECT p.id FROM posts p WHERE {self._PAIRWISE_ELIGIBLE} ORDER BY RANDOM() LIMIT ?",  # noqa: S608
            [clusters * 6],
        )
        seeds = [row[0] for row in self.cur.fetchall()]
        graph = _PairGraph(_CLOSE_PAIR_DEGREE)
        blocks: list[tuple[list[tuple[int, int]], tuple[int, float]]] = []
        harvested = 0

        for seed in seeds:
            if harvested >= count:
                break
            if seed in graph.saturated:
                continue
            members = self._similar_cluster(seed, graph.saturated)
            cap = min(_CLOSE_PAIRS_PER_CLUSTER, count - harvested)
            edges, rep = self._pair_by_silva_band([pid for pid, _ in members], graph, cap)
            if edges and rep:
                blocks.append((edges, rep))
                harvested += len(edges)

        return self._interleave_with_bridges(blocks, graph, count)

    @staticmethod
    def _interleave_with_bridges(
        blocks: list[tuple[list[tuple[int, int]], tuple[int, float]]], graph: _PairGraph, count: int,
    ) -> list[tuple[int, int]]:
        """Lay the clusters out in SILVA order, each followed by a bridge to the next.

        Two properties this ordering buys, neither of which a trailing bridge block has:

        * **Every prefix is connected.** The queue is served in position order and the
          annotator stops whenever they like, so bridges appended at the end are precisely
          the edges never reached — a half-finished round would come back as one island per
          cluster, which is the pathology the degree work exists to prevent.
        * **Bridges join the most alike neighbourhoods.** Sorting the clusters by score
          first means each bridge spans the smallest available gap, so it is a comparison
          the rater can still make rather than an arbitrary cross-link.

        Bridges are not a fixed share of the budget: connecting ``k`` clusters needs
        ``k - 1`` edges and no fewer. A cap that silently dropped them would return a
        disconnected round indistinguishable from a connected one.
        """
        blocks.sort(key=lambda blk: blk[1][1])
        out: list[tuple[int, int]] = []
        for i, (edges, (rep, _)) in enumerate(blocks):
            out.extend(edges)
            if i + 1 < len(blocks) and (edge := graph.claim(rep, blocks[i + 1][1][0])):
                out.append(edge)
        return out[:count]


    @in_thread
    def mark_done(self, queue_id: int, *, kind: str, position: int) -> bool:
        table = _ITEM_TABLES[kind]
        self.cur.execute(
            f"UPDATE {table} SET done = 1 WHERE queue_id = ? AND position = ?",  # noqa: S608
            [queue_id, position],
        )
        return self.cur.rowcount > 0

    async def sample_absolute_items(self, *, count: int, strategy: str, dimensions: list[str]) -> list[dict[str, Any]]:
        """Sample candidates with image fields — queue-less streaming annotation."""
        ids = await self.sample_post_ids(count=count, strategy=strategy, dimensions=dimensions)
        if not ids:
            return []

        def _impl() -> list[dict[str, Any]]:
            ph = sql_placeholders(ids)
            self.cur.execute(
                f"SELECT {_aliased_post_cols('p', '')} FROM posts p WHERE p.id IN ({ph})",  # noqa: S608
                ids,
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def sample_pairwise_items(self, *, count: int, strategy: str = "random") -> list[dict[str, Any]]:
        """Sample disjoint pairs with image fields for both sides — queue-less streaming."""
        pairs = await self.sample_pairs(count=count, strategy=strategy)
        if not pairs:
            return []

        def _impl() -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for a, b in pairs:
                self.cur.execute(
                    f"SELECT {_aliased_post_cols('pa', 'a_')}, {_aliased_post_cols('pb', 'b_')} "  # noqa: S608
                    "FROM posts pa, posts pb WHERE pa.id = ? AND pb.id = ?",
                    [a, b],
                )
                out += fetch_all_dicts(self.cur)
            return out

        return await asyncio.to_thread(_impl)
