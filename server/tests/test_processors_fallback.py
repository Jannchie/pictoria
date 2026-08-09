"""Characterization tests for the shared batch → mini-batch → per-image ladder.

``run_batch_with_fallback`` is the single degradation ladder every GPU worker
(waifu, embedding, tagger) shares. The ladder takes ``batch_fn`` as a
parameter, so these tests inject a fake, synchronous ``batch_fn`` — no GPU, no
models, no DB — and drive every degradation level and the ``reject_reason``
success-validation path directly.

Also pins the worker registry's failure/blacklist policy as visible data.
"""

from __future__ import annotations

from pathlib import Path

from PIL import UnidentifiedImageError

from processors.common import FALLBACK_MINI_BATCH_SIZE, run_batch_with_fallback
from processors.registry import (
    BASICS_WORKER,
    EMBEDDING_WORKER,
    SILVA_LUNA_WORKER,
    SILVA_WORKER,
    TAGGER_WORKER,
    WAIFU_WORKER,
    WORKERS,
)


def _items(*pids: int) -> list[tuple[int, Path]]:
    """Build ``(post_id, path)`` items; paths are dummies the fake fn keys on."""
    return [(pid, Path(f"/img/{pid}.jpg")) for pid in pids]


# ─── Whole-batch success (no reject_reason) ──────────────────────────────


async def test_full_batch_success_returns_all() -> None:
    def fn(paths: list[Path]) -> list[str]:
        return [f"ok:{p.name}" for p in paths]

    successes, failures = await run_batch_with_fallback(fn, _items(1, 2, 3), worker_label="test")

    assert successes == [(1, "ok:1.jpg"), (2, "ok:2.jpg"), (3, "ok:3.jpg")]
    assert failures == []


# ─── Whole batch fails → mini-batch degrade rescues everything ───────────


async def test_full_batch_failure_falls_back_to_mini_batches() -> None:
    calls: list[int] = []

    def fn(paths: list[Path]) -> list[str]:
        calls.append(len(paths))
        # The full (over-mini-size) batch blows up in the collate; any chunk
        # that already fits a mini-batch succeeds.
        if len(paths) > FALLBACK_MINI_BATCH_SIZE:
            msg = "collate boom"
            raise RuntimeError(msg)
        return [f"ok:{p.name}" for p in paths]

    # 6 items: full batch of 6 fails, then mini-batches of 4 + 2 both succeed.
    successes, failures = await run_batch_with_fallback(fn, _items(1, 2, 3, 4, 5, 6), worker_label="test")

    assert [pid for pid, _ in successes] == [1, 2, 3, 4, 5, 6]
    assert failures == []
    # Full batch (6) then two mini-batches (4, 2) — no per-image retries.
    assert calls == [6, 4, 2]


# ─── Mini-batch fails → per-image; only the bad image is blacklisted ─────


async def test_mini_batch_failure_isolates_bad_image_per_image() -> None:
    poison = 3

    def fn(paths: list[Path]) -> list[str]:
        has_poison = any(p.name == f"{poison}.jpg" for p in paths)
        # A multi-image collate containing the poison image explodes; the poison
        # image also fails on its own (unreadable), the rest decode fine.
        if has_poison and len(paths) > 1:
            msg = "collate boom"
            raise RuntimeError(msg)
        out: list[str] = []
        for p in paths:
            if p.name == f"{poison}.jpg":
                msg = "truncated image"
                raise UnidentifiedImageError(msg)
            out.append(f"ok:{p.name}")
        return out

    # 5 items, poison at pid 3 → full(5) fails, mini[1..4] (has poison) fails
    # → per-image (1,2 ok; 3 unreadable; 4 ok); mini[5] succeeds directly.
    successes, failures = await run_batch_with_fallback(fn, _items(1, 2, 3, 4, 5), worker_label="test")

    assert sorted(pid for pid, _ in successes) == [1, 2, 4, 5]
    assert failures == [(3, "UnidentifiedImageError: truncated image")]


async def test_per_image_generic_error_is_recorded_as_failure() -> None:
    def fn(paths: list[Path]) -> list[str]:
        if len(paths) > 1:
            msg = "collate boom"
            raise RuntimeError(msg)
        msg = "kaboom"
        raise ValueError(msg)

    # Single item so the full batch (len 1) raises straight into... actually
    # len-1 full batch raises ValueError and is treated as a full-batch failure,
    # then the per-image retry re-raises ValueError → recorded failure.
    successes, failures = await run_batch_with_fallback(fn, _items(7), worker_label="test")

    assert successes == []
    assert failures == [(7, "ValueError: kaboom")]


# ─── reject_reason: reclassify a produced result as a failure ────────────


async def test_reject_reason_reclassifies_empty_full_batch_result() -> None:
    def fn(paths: list[Path]) -> list[dict]:
        # pid 2's result is "empty" (mimics the tagger returning no tags).
        return [{"empty": p.name == "2.jpg"} for p in paths]

    def reject(_pid: int, result: dict) -> str | None:
        return "no auto tags produced" if result["empty"] else None

    successes, failures = await run_batch_with_fallback(
        fn,
        _items(1, 2, 3),
        worker_label="test",
        reject_reason=reject,
    )

    assert [pid for pid, _ in successes] == [1, 3]
    assert failures == [(2, "no auto tags produced")]


async def test_reject_reason_runs_at_per_image_level_too() -> None:
    def fn(paths: list[Path]) -> list[dict]:
        # Force degradation all the way to per-image: any multi-image call fails.
        if len(paths) > 1:
            msg = "collate boom"
            raise RuntimeError(msg)
        return [{"empty": p.name == "2.jpg"} for p in paths]

    def reject(_pid: int, result: dict) -> str | None:
        return "no auto tags produced" if result["empty"] else None

    successes, failures = await run_batch_with_fallback(
        fn,
        _items(1, 2),
        worker_label="test",
        reject_reason=reject,
    )

    # pid 1 decodes to a non-empty result (success); pid 2's empty per-image
    # result is rejected — proving reject_reason fires below the batch level.
    assert successes == [(1, {"empty": False})]
    assert failures == [(2, "no auto tags produced")]


async def test_no_reject_reason_keeps_every_produced_result() -> None:
    def fn(paths: list[Path]) -> list[dict]:
        return [{"empty": True} for _ in paths]

    # Without reject_reason, an "empty-looking" result is still a success —
    # this is exactly the waifu / embedding contract.
    successes, failures = await run_batch_with_fallback(fn, _items(1, 2), worker_label="test")

    assert successes == [(1, {"empty": True}), (2, {"empty": True})]
    assert failures == []


# ─── Registry: failure/blacklist policy as visible data ──────────────────


def test_worker_registry_order_and_policies() -> None:
    assert WORKERS == (BASICS_WORKER, EMBEDDING_WORKER, TAGGER_WORKER, WAIFU_WORKER, SILVA_WORKER, SILVA_LUNA_WORKER)

    by_name = {w.name: w for w in WORKERS}
    # (name -> blacklist_policy, gpu_adaptive) — the strategy, surfaced as data.
    assert by_name["Basics"].blacklist_policy == "one_shot"
    assert by_name["Basics"].gpu_adaptive is False
    assert by_name["SigLIP embeddings"].blacklist_policy == "ladder"
    assert by_name["SigLIP embeddings"].gpu_adaptive is True
    assert by_name["Tags"].blacklist_policy == "ladder"
    assert by_name["Tags"].gpu_adaptive is True
    assert by_name["Waifu scorer"].blacklist_policy == "ladder"
    assert by_name["Waifu scorer"].gpu_adaptive is True
    assert by_name["SILVA scorer"].blacklist_policy == "never"
    assert by_name["SILVA scorer"].gpu_adaptive is False
    assert by_name["SILVA-Luna scorer"].blacklist_policy == "never"
    assert by_name["SILVA-Luna scorer"].gpu_adaptive is False


def test_only_embedding_worker_has_a_post_backfill_hook() -> None:
    # The near-duplicate regroup is the sole post-backfill hook; it belongs to
    # the embedding worker (new embeddings are what make a regroup worthwhile).
    with_hook = [w.name for w in WORKERS if w.on_backfill_complete is not None]
    assert with_hook == ["SigLIP embeddings"]
