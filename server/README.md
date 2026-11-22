# Pictoria worker

The Python side of Pictoria: a [cairnq](https://pypi.org/project/cairnq/) worker that owns the GPU and **only computes** — SigLIP 2 embeddings, auto-tagging, SILVA scores, thumbnails and colours, gallery-dl / Danbooru downloads. It never opens `pictoria.sqlite`; the API in `apps/api` queues tasks, receives plain data back and does every database write. See the root [`README.md`](../README.md) and [`CLAUDE.md`](../CLAUDE.md) for the whole picture.

```bash
uv sync                 # install (Python 3.12, CUDA wheels from the cu128 index)
pnpm dev:worker         # from the repo root — runs the worker from this directory

uv run ruff check src scripts tests
uv run pytest
```

| Path | What it holds |
| --- | --- |
| `src/worker/` | cairnq entry point (`main.py`), task handlers, importers, the vector codec, the OOM fallback ladder |
| `src/ai/` | model code: SigLIP 2 embedding, SILVA scorer, LPIPS, captioning |
| `src/services/` | fetch/parse helpers (gallery-dl, the pixai tagger, the SILVA dataset) — they return rows, TS writes them |
| `src/danbooru/` | Danbooru API client used by the importers |
| `migrations/` | the library's SQL migrations — applied by `apps/api` on boot, not by anything here |
| `data/` | tag translation catalogues and the tag tree, read by `apps/api`; built by `scripts/tags/` |
| `scripts/` | one-off maintenance run by hand (backup, inspection, dataset import). These may open the database directly; `src/` may not (`sqlite3` is banned there by ruff) |

Secrets (Danbooru API key, S3 fallback credentials) go in `.env`; copy `.env.example`. Path overrides (`PICTORIA_TARGET_DIR`, `DB_PATH`, `TASKS_DB_PATH`) are environment variables, not `.env` entries.
