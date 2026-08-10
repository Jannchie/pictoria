"""cairnq task handlers — the compute half of the refactor.

Every handler here obeys one rule, the one that decides the whole design (see
``docs/refactor-monorepo-hono.md`` §D1):

    **All compute in the Python worker, all database writes in TS. No exceptions.**

So a handler takes everything it needs from the payload (paths, vectors),
returns plain data, and never opens ``pictoria.sqlite``. That is what lets the
Python ``db/`` layer be deleted whole in Phase 7 rather than surviving as a
"just this one worker still writes" residue.

A handler that raises leaves cairnq to record the failure and retry per the
task's ``max_attempts`` — which replaces the ``post_process_failures``
blacklist table for everything except the one-shot cases basics owns.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np

from worker.codec import decode_vector, encode_vector
from worker.ladder import run_with_fallback

#: Registered heads. Guarding here rather than passing ``payload["scorer"]``
#: straight into the loader keeps an arbitrary string out of a filesystem path
#: — the payload crosses a process boundary, so it is input, not a constant.
_SILVA_SCORERS = frozenset({"silva", "silva_luna"})


async def handle_silva(payload: dict[str, Any]) -> dict[str, Any]:
    """Score stored SigLIP2 embeddings with one of the SILVA heads.

    Payload is ``{scorer, items: [{postId, embedding}]}`` where ``embedding`` is
    the base64 float32 of the vector already stored in ``post_vectors_siglip2``
    — the worker does not read it back itself. Returns
    ``{scores: [{postId, score}]}`` in the same order; TS writes the rows.

    The vectors travel with the payload rather than being re-read here because
    of §D1: an exception for "this worker may read the DB" is exactly the kind
    of per-worker rule the refactor exists to remove. ``SILVA_TASK_BATCH`` (64)
    is sized for that — see the TS side for the payload-size arithmetic.
    """
    scorer = payload["scorer"]
    if scorer not in _SILVA_SCORERS:
        msg = f"unknown scorer: {scorer!r}"
        raise ValueError(msg)

    items = payload["items"]
    if not items:
        return {"scores": []}

    # Imported here rather than at module scope so an empty batch — and the
    # connectivity check that submits one — costs nothing: torch and the head
    # weights are seconds and gigabytes of VRAM.
    from ai.silva_scorer import score_embeddings  # noqa: PLC0415

    # Stacked into one [N, 1152] array rather than handed over as a list of
    # arrays: that is the shape the head wants anyway, and it makes the width
    # check in decode_vector the only place a ragged payload can fail.
    embeddings = np.stack([decode_vector(item["embedding"]) for item in items])
    # ``to_thread`` rather than a straight call: cairnq runs handlers on its own
    # event loop, and that loop is also what renews this task's lease. A
    # multi-second forward blocking it would let the lease expire and the task
    # be handed to another worker while this one is still computing it.
    scores = await asyncio.to_thread(score_embeddings, embeddings, scorer)
    return {
        "scores": [
            {"postId": item["postId"], "score": float(score)}
            for item, score in zip(items, scores, strict=True)
        ],
    }


#: Root every payload path must live under. Set once by ``main.py``; a handler
#: refuses to touch anything outside it.
#:
#: The payload crosses a process boundary through a database, so a path in it is
#: *input* — the same reason ``server/images.py`` resolves inside ``target_dir``
#: before serving a file. Nothing today writes a hostile path, and that is
#: exactly when the check is cheap to add.
_ROOT: Path | None = None


def set_root(root: Path) -> None:
    global _ROOT  # noqa: PLW0603 — process-wide config, set once at startup
    _ROOT = root.resolve()


def library_root() -> Path:
    """The configured library root. Raises if ``set_root`` never ran."""
    if _ROOT is None:
        msg = "worker root not configured"
        raise RuntimeError(msg)
    return _ROOT


def _resolve_inside(raw: str) -> Path:
    path = Path(raw).resolve()
    if _ROOT is None:
        msg = "worker root not configured"
        raise RuntimeError(msg)
    if not path.is_relative_to(_ROOT):
        msg = f"path escapes the library root: {raw}"
        raise ValueError(msg)
    return path


async def handle_waifu(payload: dict[str, Any]) -> dict[str, Any]:
    """Score images with the CLIP-backed waifu scorer.

    Payload is ``{items: [{postId, path}]}`` — absolute paths, because the
    worker has no database to look them up in (§D1). Returns
    ``{scores: [...], failures: [...]}``; TS writes the scores and decides what
    a failure means (for this worker: a one-shot blacklist, matching the old
    ``blacklist_policy = "ladder"``).

    Files that vanished between the pending query and the batch are dropped
    here rather than failed — they are not bad data, they are gone, and the
    pending query will stop offering them once the row goes too.
    """
    items_in = payload["items"]
    if not items_in:
        return {"scores": [], "failures": []}

    from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: defer the ML stack

    items: list[tuple[int, Path]] = []
    failures: list[dict[str, Any]] = []
    for item in items_in:
        try:
            path = _resolve_inside(item["path"])
        except ValueError as exc:
            failures.append({"postId": item["postId"], "error": str(exc)})
            continue
        if path.exists():
            items.append((item["postId"], path))

    # The loader itself touches disk and VRAM, so it goes off-loop too — see
    # the note in handle_silva about the lease.
    scorer = await asyncio.to_thread(get_waifu_scorer)
    successes, ladder_failures = await run_with_fallback(scorer, items, label="waifu")
    return {
        "scores": [{"postId": pid, "score": float(score)} for pid, score in successes],
        "failures": failures + [{"postId": pid, "error": err} for pid, err in ladder_failures],
    }


def _no_tags(_pid: int, resp: Any) -> str | None:
    """Reject an empty tagger response so it is blacklisted, not silently dropped.

    An empty result leaves ``post_has_tag`` untouched, so the post stays pending
    forever and re-running produces the same empty response. Passed to the
    ladder as ``reject_reason`` so the check runs identically at the full-batch,
    mini-batch and per-image levels.
    """
    if not resp.general_tags and not resp.character_tags:
        return "no auto tags produced"
    return None


async def handle_tagger(payload: dict[str, Any]) -> dict[str, Any]:
    """Auto-tag images with WDTagger.

    Returns the tags and the predicted rating as **data**. Which tag group a
    name belongs to, and whether a rating may overwrite the stored one, are
    schema questions — they belong to the side that owns the schema (§D1), so
    they are decided in TS, not here.
    """
    items_in = payload["items"]
    if not items_in:
        return {"results": [], "failures": []}

    from services.wd_tagging import get_tagger  # noqa: PLC0415  # lazy: defer the ML stack

    items: list[tuple[int, Path]] = []
    failures: list[dict[str, Any]] = []
    for item in items_in:
        try:
            path = _resolve_inside(item["path"])
        except ValueError as exc:
            failures.append({"postId": item["postId"], "error": str(exc)})
            continue
        if path.exists():
            items.append((item["postId"], path))

    tagger = await asyncio.to_thread(get_tagger)
    successes, ladder_failures = await run_with_fallback(
        tagger.tag, items, label="tagger", reject_reason=_no_tags,
    )
    return {
        "results": [
            {
                "postId": pid,
                "generalTags": list(resp.general_tags),
                "characterTags": list(resp.character_tags),
                "rating": resp.rating or "",
            }
            for pid, resp in successes
        ],
        "failures": failures + [{"postId": pid, "error": err} for pid, err in ladder_failures],
    }


async def handle_embedding(payload: dict[str, Any]) -> dict[str, Any]:
    """Encode images into SigLIP 2 retrieval embeddings.

    Vectors go back base64'd (same encoding ``handle_silva`` consumes) and TS
    writes them into the vec0 table. The initial draft made this the one
    exception to §D1 — "vectors are too big, let the worker write vec0" — and
    that exception was measured away: at the real batch size the queue round
    trip costs ~12 ms against seconds of GPU encoding.
    """
    items_in = payload["items"]
    if not items_in:
        return {"embeddings": [], "failures": []}

    from ai.siglip_embed import calculate_image_features_batch  # noqa: PLC0415  # lazy: defer the ML stack

    items: list[tuple[int, Path]] = []
    failures: list[dict[str, Any]] = []
    for item in items_in:
        try:
            path = _resolve_inside(item["path"])
        except ValueError as exc:
            failures.append({"postId": item["postId"], "error": str(exc)})
            continue
        if path.exists():
            items.append((item["postId"], path))

    def _encode(paths: list[Path]) -> list[np.ndarray]:
        features = calculate_image_features_batch(paths)
        return list(features.cpu().numpy().astype(np.float32))

    successes, ladder_failures = await run_with_fallback(_encode, items, label="embedding")
    return {
        "embeddings": [{"postId": pid, "embedding": encode_vector(emb)} for pid, emb in successes],
        "failures": failures + [{"postId": pid, "error": err} for pid, err in ladder_failures],
    }


async def handle_dedup(payload: dict[str, Any]) -> dict[str, Any]:
    """Find every near-duplicate pair in the whole library at once.

    The odd one out: its payload carries a *path* instead of data, because the
    input is every vector there is (1.0 GB of float32) and the alternative — a
    per-post vec0 KNN — is ~48h at library scale. §D1 still holds; a file is not
    a database, and this process still opens no SQL connection.

    Returns ``{pairs: [[i, j], ...]}`` of **row indices**, not post ids: the
    matrix file has no ids in it. TS holds the parallel id array and does the
    greedy canonical assignment.
    """
    from worker.dedup import find_near_pairs, load_matrix  # noqa: PLC0415  # lazy: pulls torch

    path = _resolve_inside(payload["matrixPath"])
    count = int(payload["count"])
    dim = int(payload["dim"])
    if count < 2:  # noqa: PLR2004
        return {"pairs": []}

    matrix = load_matrix(path, count, dim)
    # Off-loop like every other GPU call here: the loop that runs this handler
    # is also the one renewing its lease, and a full-library matmul is minutes.
    pairs = await asyncio.to_thread(
        find_near_pairs,
        matrix,
        float(payload["threshold"]),
        int(payload["chunkSize"]),
    )
    return {"pairs": pairs}


async def handle_text_embed(payload: dict[str, Any]) -> dict[str, Any]:
    """Encode a search prompt into the SigLIP 2 text/image joint space.

    The only *interactive* handler here — someone is waiting on the HTTP
    response — which is why it lives on its own queue with a tight poll
    interval rather than behind the backfill batches.

    ``scale`` / ``bias`` ride along with the vector because computing them
    touches torch, and the TS side is the one place that must not. They are
    constants once the model is loaded, so this costs a float each way.
    """
    prompt = payload["prompt"]

    from ai.siglip_embed import calculate_text_features, get_logit_scale_bias  # noqa: PLC0415  # lazy: defer the ML stack

    def _encode() -> tuple[np.ndarray, float, float]:
        features = calculate_text_features(prompt).cpu().numpy()[0].astype(np.float32)
        scale, bias = get_logit_scale_bias()
        return features, scale, bias

    vec, scale, bias = await asyncio.to_thread(_encode)
    return {"embedding": encode_vector(vec), "scale": scale, "bias": bias}


async def handle_thumbnail(payload: dict[str, Any]) -> dict[str, Any]:
    """Generate one thumbnail. CPU + disk only — no GPU, hence the ``io`` queue.

    A 0-byte or otherwise corrupt original makes PIL raise
    ``UnidentifiedImageError`` (or ``OSError`` for a truncated file). That is a
    *data* condition, not a server fault, so it comes back as ``ok: false`` and
    the HTTP layer turns it into a 404 — same as the Litestar path did.
    """
    from PIL import UnidentifiedImageError  # noqa: PLC0415  # lazy: PIL is not free to import

    from utils import create_thumbnail  # noqa: PLC0415

    original = _resolve_inside(payload["originalPath"])
    # Thumbnails live under ``.pictoria/thumbnails`` inside the library root,
    # so they pass the same escape guard the originals do.
    thumbnail = _resolve_inside(payload["thumbnailPath"])
    thumbnail.parent.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(create_thumbnail, original, thumbnail)
    except (UnidentifiedImageError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


async def handle_rotate(payload: dict[str, Any]) -> dict[str, Any]:
    """Rotate an image in place and describe the result.

    Rewrites the original, rebuilds its thumbnail, and returns the columns that
    change with it. ``sha256`` hashes the *encoded bytes on disk* — the same
    domain every other writer uses (``processors/basics.py``) — rather than the
    decoded pixel buffer; mixing the two would quietly break dedup.
    """
    from PIL import Image  # noqa: PLC0415  # lazy: PIL is not free to import

    from utils import calculate_arthash, calculate_sha256, create_thumbnail_by_image  # noqa: PLC0415

    original = _resolve_inside(payload["originalPath"])
    thumbnail = _resolve_inside(payload["thumbnailPath"])
    clockwise = bool(payload["clockwise"])

    def _rotate() -> dict[str, Any]:
        image = Image.open(original)
        image = image.rotate(-90 if clockwise else 90, expand=True)
        image.save(original)
        thumbnail.parent.mkdir(parents=True, exist_ok=True)
        create_thumbnail_by_image(image, thumbnail)
        file_bytes = original.read_bytes()
        return {
            "sha256": calculate_sha256(file_bytes),
            "size": len(file_bytes),
            "width": image.size[0],
            "height": image.size[1],
            "arthash": calculate_arthash(image),
        }

    return await asyncio.to_thread(_rotate)


async def handle_caption(payload: dict[str, Any]) -> dict[str, Any]:
    """Caption one image with OpenAI.

    The key lives in ``<target_dir>/.pictoria/OPENAI_API_KEY`` — the same file
    ``bootstrap.prepare_openai_api`` reads. Absent key comes back as
    ``configured: false`` rather than an exception: "not set up" is a 400 the
    HTTP layer words for itself, not a worker failure to retry.
    """
    image = _resolve_inside(payload["imagePath"])
    if _ROOT is None:
        msg = "worker root not configured"
        raise RuntimeError(msg)
    key_file = _ROOT / ".pictoria" / "OPENAI_API_KEY"
    if not key_file.is_file():
        return {"configured": False, "caption": ""}
    api_key = key_file.read_text().strip()
    if not api_key:
        return {"configured": False, "caption": ""}

    from ai.make_captions import OpenAIImageAnnotator  # noqa: PLC0415  # lazy: pulls openai + diffusers

    annotator = OpenAIImageAnnotator(api_key)
    caption = await asyncio.to_thread(annotator.annotate_image, image)
    return {"configured": True, "caption": caption}


def _compute_basics(item: dict[str, Any], thumbnails_root: Path) -> dict[str, Any]:
    """One image, one decode: sha256 / arthash / dimensions / palette / thumbnail.

    Ported from ``processors/basics.py::_compute_basics_for``. The five outputs
    stay bundled because they all ride the same file open + PIL decode —
    splitting them would decode the same image up to four times.
    """
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415
    from skimage import color as skcolor  # noqa: PLC0415

    from tools.colors import get_palette, rgb2int  # noqa: PLC0415
    from utils import calculate_arthash, calculate_sha256, create_thumbnail_by_image  # noqa: PLC0415

    path = _resolve_inside(item["path"])
    needs_sha256 = not item["hasSha256"]
    needs_arthash = not item["hasArthash"]
    needs_color = not item["hasColor"]

    colors_ints: list[int] = []
    dominant_lab: list[float] | None = None
    color_error: str | None = None

    with path.open("rb") as f:
        file_data = f.read() if needs_sha256 else None
        f.seek(0)
        # No img.verify(): it ignores LOAD_TRUNCATED_IMAGES and rejects
        # partially-downloaded files the decode below handles fine. A genuine
        # "not an image" still fails at Image.open() and bubbles up.
        with Image.open(f) as img:
            width, height = img.size

            thumb_path = thumbnails_root / item["relPath"]
            if not thumb_path.exists():
                thumb_path.parent.mkdir(parents=True, exist_ok=True)
                create_thumbnail_by_image(img, thumb_path)

            arthash = calculate_arthash(img) if needs_arthash else None
            if needs_color:
                try:
                    palette = get_palette(img)
                except Exception as exc:  # colorthief raises a bare Exception
                    color_error = str(exc)
                else:
                    colors_ints = [rgb2int(rgb) for rgb in palette]
                    if palette:
                        rgb_norm = np.array(palette[0], dtype=np.float64) / 255.0
                        dominant_lab = [float(v) for v in skcolor.rgb2lab(rgb_norm.reshape(1, 1, 3)).reshape(3)]

    return {
        "postId": item["postId"],
        "sha256": calculate_sha256(file_data) if (file_data and needs_sha256) else None,
        "size": path.stat().st_size if needs_sha256 else None,
        "arthash": arthash,
        "width": width,
        "height": height,
        "colors": colors_ints,
        "dominantLab": dominant_lab,
        "colorError": color_error,
    }


async def handle_basics(payload: dict[str, Any]) -> dict[str, Any]:
    """Compute basics for a batch, one image per thread.

    Failures are per-item and come back as data: one unreadable file must not
    cost the other 31 in the batch. A successful decode whose palette step
    failed still returns its row *and* a failure — the row carries the other
    columns, the failure one-shot blacklists the post so ``dominant_color IS
    NULL`` stops re-selecting it forever.
    """
    items = payload["items"]
    if not items:
        return {"rows": [], "failures": []}
    if _ROOT is None:
        msg = "worker root not configured"
        raise RuntimeError(msg)
    thumbnails_root = _ROOT / ".pictoria" / "thumbnails"

    async def _one(item: dict[str, Any]) -> dict[str, Any] | BaseException:
        try:
            return await asyncio.to_thread(_compute_basics, item, thumbnails_root)
        except BaseException as exc:  # reported per item, never fails the whole batch
            return exc

    results = await asyncio.gather(*[_one(item) for item in items])

    rows: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for item, result in zip(items, results, strict=True):
        if isinstance(result, BaseException):
            failures.append({"postId": item["postId"], "error": f"compute failed: {result}"})
            continue
        rows.append(result)
        if result["colorError"]:
            failures.append({"postId": item["postId"], "error": f"color: {result['colorError']}"})
    return {"rows": rows, "failures": failures}
