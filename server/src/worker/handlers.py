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
import logging
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

from paths import pictoria_dir
from worker.codec import decode_vector, encode_vector
from worker.ladder import SystemicBatchError, classify, run_with_fallback

if TYPE_CHECKING:
    from collections.abc import Callable

log = logging.getLogger("worker.handlers")


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
    # Imported here rather than at module scope, and still cheap: ``ai.silva_scorer``
    # defers torch and the head weights (seconds and gigabytes of VRAM) to the
    # first real forward, so an empty batch — and the connectivity check that
    # submits one — costs only numpy.
    from ai.silva_scorer import REPO_IDS, score_embeddings  # noqa: PLC0415

    # 用加载权重的那张表本身校验，而不是手抄一份名单：payload 跨进程而来，是输入
    # 不是常量，任意字符串不能进文件系统路径。手抄的那份会是又一处要同步的地方，
    # 漏掉的表现是任务提交成功、worker 运行时才拒。
    scorer = payload["scorer"]
    if scorer not in REPO_IDS:
        msg = f"unknown scorer: {scorer!r}"
        raise ValueError(msg)

    items = payload["items"]
    if not items:
        return {"scores": []}

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
        "scores": [{"postId": item["postId"], "score": float(score)} for item, score in zip(items, scores, strict=True)],
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
    """The configured library root. Raises if ``set_root`` never ran.

    This is the root the process was *started with* (``--target_dir`` can
    override the env var). Anything laid out under it goes through
    ``paths.pictoria_dir(library_root())`` -- the layout itself lives only in
    ``paths.py``.
    """
    if _ROOT is None:
        msg = "worker root not configured"
        raise RuntimeError(msg)
    return _ROOT


class PayloadContractError(TypeError):
    """A payload that does not match ``packages/contracts/src/tasks.ts``.

    Raised *before* any per-item work, so it fails the whole task instead of
    coming back as per-item ``failures``. That distinction is the point: TS
    writes failures into ``post_process_failures``, a permanent blacklist, and a
    renamed field is a bug in the code, not in the images -- one deploy with a
    typo must not blacklist every post the scheduler offers.

    A ``TypeError`` rather than a ``ValueError`` on purpose: the per-item paths
    below catch ``ValueError`` (an escaping path), and a contract error must
    never be swallowed by one of those.
    """


#: A contract field's accepted JSON type(s), as Python types.
FieldTypes = type | tuple[type, ...]


def _require(item: object, fields: dict[str, FieldTypes], *, where: str) -> None:
    """Check ``item`` carries every contract field with the right JSON type.

    ``bool`` is a subclass of ``int`` in Python, so an ``int`` field rejects
    booleans explicitly -- ``{"postId": true}`` is a contract error, not post 1.
    Extra keys are allowed: an additive change on the TS side must not take the
    worker down before it is redeployed.
    """
    if not isinstance(item, dict):
        msg = f"{where}: expected an object, got {type(item).__name__}"
        raise PayloadContractError(msg)
    for key, expected in fields.items():
        if key not in item:
            msg = f"{where}: missing field {key!r}"
            raise PayloadContractError(msg)
        value = item[key]
        accepted = expected if isinstance(expected, tuple) else (expected,)
        if not isinstance(value, accepted) or (isinstance(value, bool) and bool not in accepted):
            msg = f"{where}: field {key!r} has type {type(value).__name__}"
            raise PayloadContractError(msg)


#: ``ImageItem`` in ``tasks.ts``.
_IMAGE_ITEM: dict[str, FieldTypes] = {"postId": int, "path": str}


def _resolve_inside(raw: str) -> Path:
    path = Path(raw).resolve()
    root = library_root()
    if not path.is_relative_to(root):
        msg = f"path escapes the library root: {raw}"
        raise ValueError(msg)
    return path


def _contain_batch(
    batch: list[Any],
    *,
    check: Callable[[int, Any], None],
    paths: Callable[[Any], tuple[str, ...]],
    failure_ids: Callable[[Any], dict[str, Any]],
    drop_missing: str | None,
) -> tuple[list[tuple[Any, tuple[Path, ...]]], list[dict[str, Any]]]:
    """The contract and containment tiers every batch handler shares, in that order.

    ``check`` runs over the *whole* batch before any path is resolved: a missing
    or mistyped field must fail the task, never land half the batch in
    ``failures`` (see ``PayloadContractError``). Only then is each of the item's
    ``paths`` resolved inside the library root; one escaping is a per-item
    failure ``{**failure_ids(item), "error"}``, which TS blacklists.

    ``drop_missing`` is the missing-file policy. ``None`` keeps an item whose
    file is absent (the caller deals with it); a string drops it -- not failed,
    the row is not bad data and sync will notice the deletion -- and is the
    wording of the logged count, so an all-dropped batch is not silent.

    Returns ``(item, resolved_paths)`` pairs, in batch order, plus the failures.
    """
    for i, item in enumerate(batch):
        check(i, item)

    kept: list[tuple[Any, tuple[Path, ...]]] = []
    failures: list[dict[str, Any]] = []
    missing = 0
    for item in batch:
        try:
            resolved = tuple(_resolve_inside(raw) for raw in paths(item))
        except ValueError as exc:
            failures.append({**failure_ids(item), "error": str(exc)})
            continue
        if drop_missing is not None and not all(path.exists() for path in resolved):
            missing += 1
            continue
        kept.append((item, resolved))
    if missing:
        log.warning("%d/%d %s, dropped from this batch", missing, len(batch), drop_missing)
    return kept, failures


def _resolve_items(
    items_in: list[dict[str, Any]],
) -> tuple[list[tuple[int, Path]], list[dict[str, Any]]]:
    """Split incoming ``{postId, path}`` items into resolvable-and-present vs failed.

    Escaping the library root is a per-item failure (it gets blacklisted), not a
    batch failure. A path that simply no longer exists is neither -- it is dropped
    rather than failed, because the row is not bad data, the file is gone, and
    sync will notice the deletion on its own. Blacklisting it would be permanent,
    and a file can come back (an unmounted drive, a move in progress).

    Dropped is not the same as silent, though: a batch where *every* item is gone
    comes back with empty scores and empty failures, which on the TS side used to
    read as "this batch did work" and spin the scheduler loop without sleeping.
    So the count is logged here, and ``scheduler.ts`` treats an all-empty result
    as "no progress" and backs off.
    """
    kept, failures = _contain_batch(
        items_in,
        check=lambda i, item: _require(item, _IMAGE_ITEM, where=f"items[{i}]"),
        paths=lambda item: (item["path"],),
        failure_ids=lambda item: {"postId": item["postId"]},
        drop_missing="item(s) no longer on disk",
    )
    return [(item["postId"], path) for item, (path,) in kept], failures


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

    from ai.waifu_scorer import preprocess, score_tiles, warm  # noqa: PLC0415  # lazy: defer the ML stack

    items, failures = _resolve_items(items_in)

    # Decode on the shared pool, then one fp32 forward over what decoded (see
    # ``ai.waifu_scorer``). ``warm`` loads CLIP + the MLP off-loop first (see the
    # note in handle_silva about the lease).
    successes, ladder_failures = await run_with_fallback(
        preprocess,
        score_tiles,
        items,
        label="waifu",
        prepare=warm,
    )
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

    "Empty" means no ``general`` and no ``character`` tag. The other three
    categories deliberately do not count: ``meta`` alone (a bare ``highres``) is
    exactly the degenerate result this guard exists to catch, and ``style`` /
    ``copyright`` without a single subject tag means the forward pass went wrong,
    not that the image has nothing in it.
    """
    if not resp.tags.get("general") and not resp.tags.get("character"):
        return "no auto tags produced"
    return None


async def handle_tagger(payload: dict[str, Any]) -> dict[str, Any]:
    """Auto-tag images with PixAI Tagger v1.0.

    Returns the tags and the predicted rating as **data**, keyed by the *model's*
    own five categories (so ``style``, not ``artist``). Which tag group a name
    belongs to, and whether a rating may overwrite the stored one, are schema
    questions — they belong to the side that owns the schema (§D1), so they are
    decided in TS, not here.

    ``model`` rides along so TS can stamp ``posts.tagger`` with what actually
    produced these rows, instead of holding a second copy of the model name that
    could drift from the weights this process loaded.
    """
    items_in = payload["items"]
    if not items_in:
        return {"results": [], "failures": []}

    from services.pixai_tagging import (  # noqa: PLC0415  # lazy: defer the ML stack
        MODEL_TAG,
        preprocess,
        tag_tiles,
        warm,
    )

    items, failures = _resolve_items(items_in)

    successes, ladder_failures = await run_with_fallback(
        preprocess,
        tag_tiles,
        items,
        label="tagger",
        prepare=warm,
        reject_reason=_no_tags,
    )
    return {
        "model": MODEL_TAG,
        "results": [{"postId": pid, "tags": resp.tags, "rating": resp.rating} for pid, resp in successes],
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

    from ai.siglip_embed import encode_pixel_values, preprocess_images, warm  # noqa: PLC0415  # lazy: defer the ML stack

    items, failures = _resolve_items(items_in)

    def _encode(tiles: list[Any]) -> list[np.ndarray]:
        return list(encode_pixel_values(tiles).cpu().numpy().astype(np.float32))

    successes, ladder_failures = await run_with_fallback(preprocess_images, _encode, items, label="embedding", prepare=warm)
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

    Returns ``{pairs: [[i, j, distance], ...]}`` of **row indices**, not post
    ids: the matrix file has no ids in it. TS holds the parallel id array and
    turns the pairs into groups. The third element is the cosine distance --
    that is what lets the grey band tell "already the same image" from "close
    enough to be worth arbitrating".
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
        max_per_row=int(payload.get("maxPerRow") or 0),
    )
    return {"pairs": pairs}


def _resolve_pairs(
    pairs_in: list[dict[str, Any]],
) -> tuple[list[tuple[int, int, Path, Path]], list[dict[str, Any]]]:
    """``[{a: {postId, path}, b: {...}}]`` to resolvable-and-present pairs vs failed.

    Same two-tier policy as ``_resolve_items`` and for the same reasons -- a path
    escaping the library root is bad data and gets reported, a file that is
    simply gone is dropped and left to sync. The unit here is the *pair*: one
    missing file takes the pair with it, because a distance needs both sides.
    """

    def check(i: int, item: Any) -> None:
        _require(item, {"a": dict, "b": dict}, where=f"pairs[{i}]")
        _require(item["a"], _IMAGE_ITEM, where=f"pairs[{i}].a")
        _require(item["b"], _IMAGE_ITEM, where=f"pairs[{i}].b")

    kept, failures = _contain_batch(
        pairs_in,
        check=check,
        paths=lambda item: (item["a"]["path"], item["b"]["path"]),
        failure_ids=lambda item: {"a": item["a"]["postId"], "b": item["b"]["postId"]},
        drop_missing="pair(s) have a side no longer on disk",
    )
    return [(item["a"]["postId"], item["b"]["postId"], path_a, path_b) for item, (path_a, path_b) in kept], failures


def _lpips_batch(resolved: list[tuple[int, int, Path, Path]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Distances for a whole batch, falling back to one pair at a time.

    Same shape as ``ladder.run_with_fallback`` but not it: that ladder shrinks a
    batch of *images* and its mini-batch step exists to keep the GPU fed. Here
    the work is on CPU and the unit is a pair, so the intermediate step buys
    nothing -- go straight to per-pair on the first exception and only the
    unreadable pair is lost.
    """
    from ai.lpips import pair_distances  # noqa: PLC0415  # lazy: pulls onnxruntime

    try:
        distances = pair_distances([(path_a, path_b) for _, _, path_a, path_b in resolved])
    except Exception as exc:
        log.warning("[lpips] batch of %d failed (%s); retrying pair by pair", len(resolved), exc)
    else:
        return [{"a": id_a, "b": id_b, "distance": distance} for (id_a, id_b, _, _), distance in zip(resolved, distances, strict=True)], []

    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for id_a, id_b, path_a, path_b in resolved:
        try:
            (distance,) = pair_distances([(path_a, path_b)])
        except Exception as exc:
            failures.append({"a": id_a, "b": id_b, "error": str(exc)})
        else:
            results.append({"a": id_a, "b": id_b, "distance": distance})
    return results, failures


async def handle_lpips_verify(payload: dict[str, Any]) -> dict[str, Any]:
    """Judge whether each pair is the same drawing, edited -- the grey-band arbiter.

    Payload is ``{pairs: [{a: {postId, path}, b: {postId, path}}]}`` with
    absolute *thumbnail* paths: LPIPS resizes to 400x400 anyway, so decoding the
    full-resolution original would be pure waste, and thumbnails already exist
    for everything the recall step can propose.

    Returns raw distances and nothing else. Whether 0.31 counts as "the same
    picture" is a threshold, thresholds live in TS, and the evidence table
    stores these numbers rather than a verdict so that retuning costs no
    recomputation (§D1's spirit: the worker computes, TS decides).
    """
    pairs_in = payload["pairs"]
    if not pairs_in:
        return {"results": [], "failures": []}

    resolved, failures = _resolve_pairs(pairs_in)
    if not resolved:
        return {"results": [], "failures": failures}

    # Off-loop like the GPU handlers: this thread also renews the task lease,
    # and a 64-pair batch is tens of seconds of CPU-bound ONNX.
    results, batch_failures = await asyncio.to_thread(_lpips_batch, resolved)
    return {"results": results, "failures": failures + batch_failures}


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


def _save_kwargs(src: Any) -> dict[str, Any]:
    """What ``Image.save`` needs to write ``src``'s format back without losing anything.

    * ``icc_profile`` / ``exif`` from the source — a rotate must not strip colour
      management or camera metadata. EXIF keeps everything **except**
      ``Orientation``: the pixels are rotated for real, and an orientation tag
      left in place would have viewers rotate them a second time (and disagree
      with the width / height / thumbnail returned here, all computed from the
      raw pixels).
    * PNG text chunks (``tEXt`` / ``zTXt`` / ``iTXt``) through ``pnginfo``. This is
      where AI-generated images keep their generation parameters.
    * JPEG at quality 95 with the source's own chroma subsampling. ``"keep"``
      cannot be passed: PIL only accepts it for a ``JpegImageFile``, and the
      rotated image is a plain one, so the source's sampling is read up front.
    """
    from PIL import JpegImagePlugin, PngImagePlugin  # noqa: PLC0415

    kwargs: dict[str, Any] = {}
    if icc := src.info.get("icc_profile"):
        kwargs["icc_profile"] = icc
    exif = src.getexif()
    if exif:
        exif.pop(0x0112, None)  # Orientation
        kwargs["exif"] = exif.tobytes()
    if src.format == "PNG":
        text = getattr(src, "text", None) or {}
        if text:
            info = PngImagePlugin.PngInfo()
            for key, value in text.items():
                if isinstance(value, PngImagePlugin.iTXt):
                    info.add_itxt(key, value, value.lang or "", value.tkey or "")
                else:
                    info.add_text(key, value)
            kwargs["pnginfo"] = info
    elif src.format == "JPEG":
        kwargs["quality"] = 95
        sampling = JpegImagePlugin.get_sampling(src)
        if sampling != -1:
            kwargs["subsampling"] = sampling
    elif src.format == "WEBP" and src.info.get("lossless"):
        kwargs["lossless"] = True
    return kwargs


async def handle_rotate(payload: dict[str, Any]) -> dict[str, Any]:
    """Rotate an image in place and describe the result.

    Rewrites the original, rebuilds its thumbnail, and returns the columns that
    change with it. ``sha256`` hashes the *encoded bytes on disk* — the same
    domain every other writer uses (``processors/basics.py``) — rather than the
    decoded pixel buffer; mixing the two would quietly break dedup.

    Lossless where the format allows and atomic everywhere: ``transpose`` moves
    pixels without resampling (``rotate`` interpolates even at 90°), metadata
    rides along (:func:`_save_kwargs`), and the new file is written next to the
    original and swapped in with ``os.replace`` — a crash mid-save leaves the
    original intact, not a half-written file under its name.
    """
    import os  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    from PIL import Image  # noqa: PLC0415  # lazy: PIL is not free to import

    from utils import calculate_arthash, calculate_sha256, create_thumbnail_by_image  # noqa: PLC0415

    original = _resolve_inside(payload["originalPath"])
    thumbnail = _resolve_inside(payload["thumbnailPath"])
    clockwise = bool(payload["clockwise"])

    def _rotate() -> dict[str, Any]:
        with Image.open(original) as src:
            fmt = src.format
            # PIL's angles are counter-clockwise: ROTATE_270 is a quarter turn
            # clockwise, the same as the old ``rotate(-90, expand=True)``.
            rotated = src.transpose(Image.Transpose.ROTATE_270 if clockwise else Image.Transpose.ROTATE_90)
            kwargs = _save_kwargs(src)
        fd, tmp_name = tempfile.mkstemp(dir=original.parent, prefix=f".{original.name}.", suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as out:
                rotated.save(out, format=fmt, **kwargs)
            tmp.replace(original)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        thumbnail.parent.mkdir(parents=True, exist_ok=True)
        create_thumbnail_by_image(rotated, thumbnail)
        file_bytes = original.read_bytes()
        return {
            "sha256": calculate_sha256(file_bytes),
            "size": len(file_bytes),
            "width": rotated.size[0],
            "height": rotated.size[1],
            "arthash": calculate_arthash(rotated),
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
    key_file = pictoria_dir(library_root()) / "OPENAI_API_KEY"
    if not key_file.is_file():
        return {"configured": False, "caption": ""}
    api_key = key_file.read_text().strip()
    if not api_key:
        return {"configured": False, "caption": ""}

    from ai.make_captions import OpenAIImageAnnotator  # noqa: PLC0415  # lazy: pulls openai

    annotator = OpenAIImageAnnotator(api_key)
    caption = await asyncio.to_thread(annotator.annotate_image, image)
    return {"configured": True, "caption": caption}


#: ``BasicsItem`` in ``tasks.ts``. Checked for the whole batch before any image
#: is opened -- see ``PayloadContractError``.
_BASICS_ITEM: dict[str, FieldTypes] = {
    "postId": int,
    "path": str,
    "thumbnailPath": str,
    "hasSha256": bool,
    "hasArthash": bool,
    "hasColor": bool,
}

#: Threads for basics, apart from asyncio's default executor.
BASICS_WORKERS = 8


@cache
def _basics_pool() -> ThreadPoolExecutor:
    """basics' own pool, so a backlog cannot take the default executor.

    Every Worker in ``main.py`` shares one event loop, and with it the default
    executor that ``asyncio.to_thread`` draws from — the GPU handlers' forwards,
    on-demand thumbnails, rotate, caption. basics gathers a whole batch at once,
    and with ``IO_CONCURRENCY`` batches in flight that is over a hundred jobs,
    enough to queue a thumbnail a user is waiting on behind a library-wide
    backfill. Eight threads here (decode + hash + palette, mostly in C with the
    GIL released) and the default pool stays free for the rest.
    """
    return ThreadPoolExecutor(max_workers=BASICS_WORKERS, thread_name_prefix="basics")


def _compute_basics(item: dict[str, Any], path: Path, thumb_path: Path) -> dict[str, Any]:
    """One image, one decode: sha256 / arthash / dimensions / palette / thumbnail.

    Ported from ``processors/basics.py::_compute_basics_for``. The five outputs
    stay bundled because they all ride the same file open + PIL decode —
    splitting them would decode the same image up to four times.

    ``item`` has passed :func:`_require` and both paths ``_resolve_inside``, so
    nothing here can fail on the payload's shape -- only on the file.
    """
    from PIL import Image  # noqa: PLC0415
    from skimage import color as skcolor  # noqa: PLC0415

    from tools.colors import get_palette, rgb2int  # noqa: PLC0415
    from utils import calculate_arthash, calculate_sha256, create_thumbnail_by_image  # noqa: PLC0415

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


def _resolve_basics(
    items: list[dict[str, Any]],
) -> tuple[list[tuple[dict[str, Any], Path, Path]], list[dict[str, Any]]]:
    """The contract and containment tiers of :func:`handle_basics`.

    Every item is checked before any is resolved, so a contract error raises
    with nothing half-done; an escaping path is then a per-item failure. A
    missing file is *not* dropped here: it fails in ``_compute_basics`` and is
    reported per item.
    """
    kept, failures = _contain_batch(
        items,
        check=lambda i, item: _require(item, _BASICS_ITEM, where=f"items[{i}]"),
        paths=lambda item: (item["path"], item["thumbnailPath"]),
        failure_ids=lambda item: {"postId": item["postId"]},
        drop_missing=None,
    )
    return [(item, path, thumb_path) for item, (path, thumb_path) in kept], failures


async def handle_basics(payload: dict[str, Any]) -> dict[str, Any]:
    """Compute basics for a batch, one image per thread.

    Three tiers, decided in this order:

    * **Contract** -- every item is checked against ``BasicsItem`` before any
      file is opened. A missing or mistyped field raises
      :class:`PayloadContractError` and fails the whole task: no rows, no
      failures, nothing blacklisted. cairnq records it, and the batch is offered
      again once the code is fixed.
    * **Containment** -- a path outside the library root is a per-item failure,
      the same policy as ``_resolve_items``.
    * **The image** -- one unreadable file must not cost the other 31 in the
      batch. Every ``Exception`` from one image is sorted by the ladder's
      :func:`~worker.ladder.classify`: a *systemic* one (``PermissionError``,
      ``MemoryError``) is the process's problem and raises
      :class:`~worker.ladder.SystemicBatchError` -- nothing is blacklisted, the
      loop backs off and retries. Anything else, including types nobody listed
      (PIL plugins raise a zoo of them), is a per-item failure: failing the
      task on one would re-select the same id-ordered batch forever.

    A successful decode whose palette step failed still returns its row *and* a
    failure — the row carries the other columns, the failure one-shot
    blacklists the post so ``dominant_color IS NULL`` stops re-selecting it
    forever.

    The thumbnail path arrives in the payload (TS's ``thumbnailPathFor``), as it
    does for ``thumbnail`` and ``rotate``: thumbnail layout is TS knowledge.
    """
    resolved, failures = _resolve_basics(payload["items"])
    rows: list[dict[str, Any]] = []
    if not resolved:
        return {"rows": rows, "failures": failures}

    loop = asyncio.get_running_loop()
    pool = _basics_pool()

    async def _one(item: dict[str, Any], path: Path, thumb_path: Path) -> dict[str, Any] | BaseException:
        try:
            return await loop.run_in_executor(pool, _compute_basics, item, path, thumb_path)
        except Exception as exc:  # classified below, once every image has finished
            return exc

    results = await asyncio.gather(*[_one(*r) for r in resolved])

    for (item, path, _), result in zip(resolved, results, strict=True):
        if isinstance(result, BaseException) and classify(result) == "systemic":
            msg = f"[basics] systemic error on post {item['postId']} ({path}): {type(result).__name__}: {result}"
            raise SystemicBatchError(msg) from result

    for (item, _, _), result in zip(resolved, results, strict=True):
        if isinstance(result, BaseException):
            failures.append({"postId": item["postId"], "error": f"compute failed: {result}"})
            continue
        rows.append(result)
        if result["colorError"]:
            failures.append({"postId": item["postId"], "error": f"color: {result['colorError']}"})
    return {"rows": rows, "failures": failures}
