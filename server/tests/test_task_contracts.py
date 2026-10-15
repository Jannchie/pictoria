"""Cross-language task contracts — the twin of ``packages/contracts/src/tasks.test.ts``.

Both suites read the same ``packages/contracts/fixtures/tasks/<name>.json``: one
example payload and one example result per cairnq task. The TS side pins the
fixtures to the interfaces in ``tasks.ts`` (exact key sets, every level). This
side pins the worker to the fixtures:

* ``worker.main.TASKS`` registers every fixture's task name, on its queue;
* every handler reads **only** keys the fixture payload has (a ``dict``
  subclass records each lookup), so a renamed field fails here rather than as a
  ``KeyError`` in production;
* every handler returns **exactly** the fixture result's key set, every level.

Handlers that need a model run with the model call replaced by a fake (a stub
module in ``sys.modules``, or a monkeypatched attribute) -- the contract is the
shape around the model, not its numbers. ``basics``, ``thumbnail`` and ``rotate``
run for real on small images in a temporary library.

Fixture paths live under ``/library/``; each test rebases them into ``tmp_path``.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from types import ModuleType, SimpleNamespace
from typing import TYPE_CHECKING, Any

import numpy as np
import pytest
from PIL import Image

from paths import REPO_ROOT
from worker import handlers, importers
from worker.handlers import PayloadContractError
from worker.main import TASKS

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

FIXTURE_DIR = REPO_ROOT / "packages" / "contracts" / "fixtures"
FIXTURES: dict[str, dict[str, Any]] = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted((FIXTURE_DIR / "tasks").glob("*.json"))}

#: Fixture placeholder for the library root.
LIB = "/library/"

#: Mappings whose keys are data (tag names, group types), not contract fields.
#: Same set as ``'record'`` in the TS suite's shapes.
RECORD_PATHS = frozenset({"typeToGroupId", "rows[].tags", "items[].tagsByCategory"})


# ─── key recording ──────────────────────────────────────────────────────────


def _child(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


class RecordingDict(dict):
    """A payload object that remembers every key a handler looked up."""

    def __init__(self, data: dict[str, Any], read: set[str], path: str) -> None:
        super().__init__(data)
        self._read = read
        self._path = path

    def __getitem__(self, key: str) -> Any:
        self._read.add(_child(self._path, key))
        return super().__getitem__(key)

    def get(self, key: str, default: Any = None) -> Any:
        self._read.add(_child(self._path, key))
        return super().get(key, default)


def _wrap(value: Any, read: set[str], path: str = "") -> Any:
    if path in RECORD_PATHS:
        return value
    if isinstance(value, dict):
        return RecordingDict({k: _wrap(v, read, _child(path, k)) for k, v in value.items()}, read, path)
    if isinstance(value, list):
        return [_wrap(v, read, f"{path}[]") for v in value]
    return value


def _key_paths(value: Any, path: str = "") -> set[str]:
    """Every key path the fixture defines, in :class:`RecordingDict` notation."""
    if path in RECORD_PATHS:
        return set()
    if isinstance(value, dict):
        out: set[str] = set()
        for k, v in value.items():
            out.add(_child(path, k))
            out |= _key_paths(v, _child(path, k))
        return out
    if isinstance(value, list):
        return set().union(*(_key_paths(v, f"{path}[]") for v in value)) if value else set()
    return set()


def _json_kind(value: Any) -> str:  # noqa: PLR0911 -- one return per JSON kind reads best
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float) and not isinstance(value, np.generic):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list | tuple):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__  # numpy scalars & co. -- not JSON, so a mismatch


def _shape_errors(actual: Any, expected: Any, path: str = "result") -> list[str]:  # noqa: PLR0911 -- one return per shape case
    """Where ``actual`` departs from the fixture's structure (empty = it matches).

    Objects must have the same key set; object arrays are compared element by
    element against the fixture's first element; leaves must be the same JSON
    kind, with ``null`` matching anything (nullable fields).
    """
    rel = path.removeprefix("result").lstrip(".")
    if rel in RECORD_PATHS:
        return [] if isinstance(actual, dict) else [f"{path}: expected a mapping"]
    if actual is None or expected is None:
        return []
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path}: expected an object, got {_json_kind(actual)}"]
        errors = [f"{path}.{k}: missing" for k in expected.keys() - actual.keys()]
        errors += [f"{path}.{k}: not in the contract" for k in actual.keys() - expected.keys()]
        for k in expected.keys() & actual.keys():
            errors += _shape_errors(actual[k], expected[k], f"{path}.{k}")
        return sorted(errors)
    if isinstance(expected, list) and expected and isinstance(expected[0], dict):
        if not isinstance(actual, list) or not actual:
            return [f"{path}: expected a non-empty array of objects"]
        return [e for item in actual for e in _shape_errors(item, expected[0], f"{path}[]")]
    if _json_kind(actual) != _json_kind(expected):
        return [f"{path}: {_json_kind(actual)} where the fixture has {_json_kind(expected)}"]
    return []


def _rebase(value: Any, root: Path) -> Any:
    if isinstance(value, str) and value.startswith(LIB):
        return str(root / value.removeprefix(LIB))
    if isinstance(value, dict):
        return {k: _rebase(v, root) for k, v in value.items()}
    if isinstance(value, list):
        return [_rebase(v, root) for v in value]
    return value


# ─── fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path.resolve()
    monkeypatch.setattr(handlers, "_ROOT", root)
    return root


def _image(path: Path, size: tuple[int, int] = (48, 64)) -> Path:
    """A real, varied image -- colorthief rejects a flat one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(len(path.name))
    Image.fromarray(rng.integers(0, 256, (*size[::-1], 3), dtype=np.uint8)).save(path)
    return path


def _garbage(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not an image")
    return path


def _stub(monkeypatch: pytest.MonkeyPatch, name: str, **attrs: Any) -> None:
    """Install a fake module so a handler's lazy ``from <name> import ...`` gets it."""
    module = ModuleType(name)
    for k, v in attrs.items():
        setattr(module, k, v)
    monkeypatch.setitem(sys.modules, name, module)


class _FakeTensor:
    def __init__(self, arr: np.ndarray) -> None:
        self._arr = arr

    def cpu(self) -> _FakeTensor:
        return self

    def numpy(self) -> np.ndarray:
        return self._arr


def _fails_on(name: str, ok: Callable[[list[Path]], list[Any]]) -> Callable[[list[Path]], list[Any]]:
    """A batch function that raises like PIL whenever ``name`` is in the batch."""

    def run(paths: list[Path]) -> list[Any]:
        if any(p.name == name for p in paths):
            msg = "image file is truncated"
            raise OSError(msg)
        return ok(paths)

    return run


def _setup_silva(monkeypatch: pytest.MonkeyPatch, _root: Path) -> None:
    import ai.silva_scorer  # cheap: torch is deferred to the first forward

    monkeypatch.setattr(ai.silva_scorer, "score_embeddings", lambda emb, _scorer: [0.5] * len(emb))


def _setup_waifu(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    _image(root / "art/1.png")
    _image(root / "art/2.png")
    scorer = _fails_on("2.png", lambda paths: [6.5] * len(paths))
    _stub(monkeypatch, "ai.waifu_scorer", get_waifu_scorer=lambda: scorer)


def _setup_tagger(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    _image(root / "art/1.png")
    _image(root / "art/2.png")
    tags = {"general": ["1girl"], "character": [], "copyright": [], "style": [], "meta": []}

    def tag_batch(paths: list[Path]) -> list[Any]:
        # 2.png comes back empty -- the handler's own reject_reason fails it.
        return [SimpleNamespace(tags=tags if p.name == "1.png" else {}, rating="general") for p in paths]

    _stub(monkeypatch, "services.pixai_tagging", MODEL_TAG="pixai-tagger-v1.0", tag_batch=tag_batch, warm=lambda: None)


def _siglip_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    features = _fails_on("2.png", lambda paths: _FakeTensor(np.zeros((len(paths), 1152), dtype=np.float32)))  # type: ignore[arg-type,return-value]
    _stub(
        monkeypatch,
        "ai.siglip_embed",
        calculate_image_features_batch=features,
        calculate_text_features=lambda _prompt: _FakeTensor(np.zeros((1, 1152), dtype=np.float32)),
        get_logit_scale_bias=lambda: (117.3, -12.9),
    )


def _setup_embedding(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    _image(root / "art/1.png")
    _image(root / "art/2.png")
    _siglip_stub(monkeypatch)


def _setup_text_embed(monkeypatch: pytest.MonkeyPatch, _root: Path) -> None:
    _siglip_stub(monkeypatch)


def _setup_dedup(monkeypatch: pytest.MonkeyPatch, _root: Path) -> None:
    _stub(
        monkeypatch,
        "worker.dedup",
        load_matrix=lambda _path, count, dim: np.zeros((count, dim), dtype=np.float32),
        find_near_pairs=lambda _m, _threshold, _chunk, max_per_row=0: [[0, 2, 0.004]],
    )


def _setup_lpips(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    for n in (1, 2, 3):
        _image(root / f".pictoria/thumbnails/art/{n}.png")

    def pair_distances(pairs: list[tuple[Path, Path]]) -> list[float]:
        if any(b.name == "3.png" for _, b in pairs):
            msg = "cannot identify image file"
            raise OSError(msg)
        return [0.145] * len(pairs)

    _stub(monkeypatch, "ai.lpips", pair_distances=pair_distances)


def _setup_thumbnail(_monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    # The fixture result is the failure shape (``ok`` + ``error``), so feed it
    # bytes PIL cannot open; the success shape is a subset, checked separately.
    _garbage(root / "art/1.png")


def _setup_rotate(_monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    _image(root / "art/1.png")


def _setup_caption(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    _image(root / "art/1.png")
    (root / ".pictoria").mkdir(parents=True, exist_ok=True)
    (root / ".pictoria/OPENAI_API_KEY").write_text("sk-test")

    class Annotator:
        def __init__(self, _key: str) -> None:
            pass

        def annotate_image(self, _path: Path) -> str:
            return "a test caption"

    _stub(monkeypatch, "ai.make_captions", OpenAIImageAnnotator=Annotator)


def _setup_basics(_monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    _image(root / "art/1.png", (96, 128))
    _garbage(root / "art/2.png")


def _danbooru_post(post_id: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=post_id,
        file_url=f"https://cdn.donmai.us/{post_id}.png",
        file_ext="png",
        rating="g",
        source="",
        created_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC),
        tag_string_artist="some_artist",
        tag_string_character="",
        tag_string_copyright="",
        tag_string_general="1girl solo",
        tag_string_meta="highres",
    )


def _setup_danbooru(monkeypatch: pytest.MonkeyPatch, _root: Path) -> None:
    class Client:
        def get_posts(self, **_kwargs: Any) -> list[Any]:
            return [_danbooru_post(1234567), _danbooru_post(1234000)]

        def download_posts(self, posts: list[Any], save_dir: Path) -> dict[str, int]:
            for p in posts:
                _image(save_dir / f"{p.id}.{p.file_ext}")
            return {"downloaded": len(posts), "skipped": 0, "failed": 0}

    monkeypatch.setattr(importers, "_danbooru_client", Client())


def _setup_url_scan(monkeypatch: pytest.MonkeyPatch, _root: Path) -> None:
    from services import gallery_dl_import

    meta = {
        "category": "yandere",
        "id": 123,
        "extension": "png",
        "rating": "s",
        "tags": "1girl solo",
        "search_tags": "some_artist",
        "date": "2026-01-02T03:04:05",
    }
    monkeypatch.setattr(gallery_dl_import, "run_gallery_dl_json", lambda _url, config_path=None: [("https://files.yande.re/123.png", meta)])


def _setup_url_download(monkeypatch: pytest.MonkeyPatch, _root: Path) -> None:
    from services import gallery_dl_import

    monkeypatch.setattr(gallery_dl_import, "download_items", lambda items, _save_dir, headers=None: list(items))


SETUPS: dict[str, Callable[[pytest.MonkeyPatch, Path], None]] = {
    "silva": _setup_silva,
    "waifu": _setup_waifu,
    "tagger": _setup_tagger,
    "embedding": _setup_embedding,
    "dedup": _setup_dedup,
    "text-embed": _setup_text_embed,
    "lpips-verify": _setup_lpips,
    "thumbnail": _setup_thumbnail,
    "rotate": _setup_rotate,
    "caption": _setup_caption,
    "basics": _setup_basics,
    "danbooru-import": _setup_danbooru,
    "url-scan": _setup_url_scan,
    "url-download": _setup_url_download,
}


# ─── registration ───────────────────────────────────────────────────────────


def test_there_is_a_fixture_for_every_task() -> None:
    assert sorted(FIXTURES) == sorted(TASKS)
    assert sorted(SETUPS) == sorted(TASKS)


@pytest.mark.parametrize("name", sorted(FIXTURES))
def test_worker_serves_the_task_on_the_fixture_queue(name: str) -> None:
    queue, _handler = TASKS[name]
    assert queue == FIXTURES[name]["queue"]


def test_silva_scorer_names_match_the_typescript_side() -> None:
    from ai.silva_scorer import REPO_IDS

    ts_names = json.loads((FIXTURE_DIR / "silva-scorers.json").read_text(encoding="utf-8"))
    assert sorted(REPO_IDS) == sorted(ts_names)


# ─── handlers against the fixtures ──────────────────────────────────────────


@pytest.mark.parametrize("name", sorted(FIXTURES))
async def test_handler_reads_only_contract_keys_and_returns_the_contract_shape(
    name: str,
    library: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = FIXTURES[name]
    SETUPS[name](monkeypatch, library)
    read: set[str] = set()
    payload = _wrap(_rebase(fixture["payload"], library), read)

    _queue, handler = TASKS[name]
    result = await handler(payload)

    unknown = read - _key_paths(fixture["payload"])
    assert not unknown, f"{name} reads keys the contract does not have: {sorted(unknown)}"
    assert _shape_errors(result, fixture["result"]) == []
    # The result goes back through JSON; a numpy scalar would fail right here.
    json.dumps(result)


async def test_thumbnail_success_shape_is_a_subset_of_the_contract(library: Path) -> None:
    original = _image(library / "art/1.png")
    result = await handlers.handle_thumbnail({"originalPath": str(original), "thumbnailPath": str(library / ".pictoria/thumbnails/art/1.png")})
    assert result == {"ok": True}
    assert result.keys() <= FIXTURES["thumbnail"]["result"].keys()


def test_recorder_sees_nested_reads_and_skips_record_children() -> None:
    read: set[str] = set()
    payload = _wrap({"items": [{"postId": 1, "relPath": "x"}], "typeToGroupId": {"artist": 1}}, read)
    _ = payload["items"][0]["relPath"], payload["typeToGroupId"]["artist"], payload.get("maxPerRow")
    assert read == {"items", "items[].relPath", "typeToGroupId", "maxPerRow"}
    assert read - _key_paths({"items": [{"postId": 1}], "typeToGroupId": {}}) == {"items[].relPath", "maxPerRow"}


def test_shape_checker_catches_a_rename() -> None:
    expected = {"rows": [{"postId": 1, "width": 2}], "failures": []}
    assert _shape_errors({"rows": [{"postId": 1, "w": 2}], "failures": []}, expected) == [
        "result.rows[].w: not in the contract",
        "result.rows[].width: missing",
    ]
    assert _shape_errors({"rows": [{"postId": np.int64(1), "width": 2}], "failures": []}, expected) == [
        "result.rows[].postId: int64 where the fixture has number",
    ]


# ─── basics: contract errors fail the task, image errors fail the item ──────


def _basics_item(library: Path, **overrides: Any) -> dict[str, Any]:
    item = _rebase(FIXTURES["basics"]["payload"]["items"][0], library)
    item.update(overrides)
    return item


@pytest.mark.parametrize("field", ["postId", "path", "thumbnailPath", "hasSha256", "hasArthash", "hasColor"])
async def test_basics_missing_field_fails_the_whole_task(library: Path, field: str) -> None:
    _image(library / "art/1.png")
    good = _basics_item(library)
    broken = _basics_item(library)
    del broken[field]

    # The broken item is *second*: the good one must not have been processed
    # (no thumbnail written) before the contract check raised.
    with pytest.raises(PayloadContractError, match=field):
        await handlers.handle_basics({"items": [good, broken]})
    assert not (library / ".pictoria/thumbnails/art/1.png").exists()


@pytest.mark.parametrize(
    ("field", "value"),
    [("hasColor", "yes"), ("postId", True), ("postId", "1"), ("path", None), ("thumbnailPath", 3)],
)
async def test_basics_mistyped_field_fails_the_whole_task(library: Path, field: str, value: Any) -> None:
    with pytest.raises(PayloadContractError, match=field):
        await handlers.handle_basics({"items": [_basics_item(library, **{field: value})]})


async def test_basics_the_old_payload_shape_is_rejected_not_blacklisted(library: Path) -> None:
    # Exactly the drift this guards against: an API still sending ``relPath``.
    item = _basics_item(library)
    item["relPath"] = "art/1.png"
    del item["thumbnailPath"]
    with pytest.raises(PayloadContractError, match="thumbnailPath"):
        await handlers.handle_basics({"items": [item]})


async def test_basics_unreadable_image_is_a_per_item_failure(library: Path) -> None:
    _garbage(library / "art/1.png")
    result = await handlers.handle_basics({"items": [_basics_item(library)]})
    assert result["rows"] == []
    assert [f["postId"] for f in result["failures"]] == [1]


async def test_basics_an_unexpected_per_image_error_is_a_per_item_failure(library: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An exception type nobody listed must not fail the task: the pending query
    is id-ordered, so a failed task would re-select the same batch forever."""
    _image(library / "art/1.png")

    def broken(*_args: Any) -> dict[str, Any]:
        raise IndexError  # e.g. the palette step on a 1x1 image

    monkeypatch.setattr(handlers, "_compute_basics", broken)
    result = await handlers.handle_basics({"items": [_basics_item(library)]})
    assert result["rows"] == []
    assert [f["postId"] for f in result["failures"]] == [1]


async def test_basics_writes_the_thumbnail_where_the_payload_says(library: Path) -> None:
    _image(library / "art/1.png", (800, 600))
    target = library / ".pictoria/thumbnails/elsewhere/x.png"
    result = await handlers.handle_basics({"items": [_basics_item(library, thumbnailPath=str(target))]})
    assert [r["postId"] for r in result["rows"]] == [1]
    assert target.exists()
    with Image.open(target) as thumb:
        assert thumb.width == 400


async def test_basics_escaping_thumbnail_path_is_a_per_item_failure(library: Path, tmp_path_factory: pytest.TempPathFactory) -> None:
    _image(library / "art/1.png")
    outside = tmp_path_factory.mktemp("elsewhere") / "x.png"
    result = await handlers.handle_basics({"items": [_basics_item(library, thumbnailPath=str(outside))]})
    assert result["rows"] == []
    assert "escapes the library root" in result["failures"][0]["error"]
    assert not outside.exists()


# ─── the other item resolvers: same rule ────────────────────────────────────


async def test_image_item_without_path_fails_the_task_not_the_item(library: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _setup_waifu(monkeypatch, library)
    with pytest.raises(PayloadContractError, match="path"):
        await handlers.handle_waifu({"items": [{"postId": 1, "path": str(library / "art/1.png")}, {"postId": 2}]})


def test_lpips_pair_without_post_id_fails_the_task(library: Path) -> None:
    pair = {"a": {"path": str(library / "a.png")}, "b": {"postId": 2, "path": str(library / "b.png")}}
    with pytest.raises(PayloadContractError, match="postId"):
        handlers._resolve_pairs([pair])
