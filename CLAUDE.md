# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pictoria is a full-stack image gallery application for managing and displaying images, particularly AI-generated art. It features automatic tagging, vector-based similarity search, and quality scoring.

## Tech Stack

- **API**: TypeScript on Hono (`apps/api`), embedded SQLite (WAL) + `sqlite-vec` (vec0 virtual tables for vector search), hand-written repositories in `packages/db` (raw SQL; no ORM in the query path — `drizzle-orm` appears only as the hand-written table declarations in `schema.ts`, checked column-by-column against the migrations by `schema.test.ts`)
- **Worker**: Python 3.11+ (dev pins 3.12) running under [cairnq](https://pypi.org/project/cairnq/) (`server/src/worker`). It **computes only** — torch / transformers / gallery-dl are the reason it exists. It never opens `pictoria.sqlite`
- **Frontend**: Vue 3 with Composition API, Vite, UnoCSS, TypeScript
- **Package Managers**: `uv` for Python, `pnpm` for JavaScript

## Essential Commands

### Development

Everything runs through pnpm scripts from the repo root (there is no justfile).

```bash
# All three dev processes: Hono API (4777), cairnq worker (GPU), Vite (4778)
pnpm dev

# Or one at a time
pnpm dev:api        # Hono API
pnpm dev:worker     # cairnq worker — must run from server/, so the script cd's there
pnpm dev:web        # Vite

# Generate the API client after backend changes
pnpm genapi
```

`pnpm dev` runs the three under `concurrently -k`, so output is prefixed per process
and one Ctrl+C stops all of them.

`dev:api` is `node --watch-path=src --watch-path=../../packages/db/src
--watch-path=../../packages/contracts/src --import tsx src/index.ts`: saving a file in
any of those three trees restarts the API. A half-written edit that crashes it on boot
makes `concurrently -k` take the worker and Vite down with it — so editing API/db code
while someone's `pnpm dev` is running interrupts their session. `pnpm dev:api-quiet`
(`PICTORIA_SCHEDULER=0`) starts an API without the backfill loops, e.g. for `pnpm genapi`.

⚠️ Do **not** rewrite it as a POSIX `(trap 'kill 0' SIGINT; a & b & wait)` one-liner.
`pnpm config get script-shell` reports msys bash on this machine, but root scripts
actually execute under cmd.exe — `trap` and `wait` come back "not recognized", the
parent exits immediately, and the children die with it. Measured, not assumed.

### Checks

```bash
pnpm check        # everything CI runs, nothing auto-fixes (scripts/check.mjs)
pnpm typecheck    # pnpm -r typecheck (tsc / vue-tsc --noEmit in every package)
```

`pnpm check` runs, in order and without stopping at the first failure:
`pnpm -r typecheck`, `pnpm -r test`, `pnpm -r --if-present lint:check` (ESLint without
`--fix`), then in `server/` `uv run ruff check src scripts tests` and `uv run pytest`.
CI (`.github/workflows/ci.yml`) runs the same steps on a GPU-less runner: the SigLIP
forward tests skip without CUDA, the LPIPS ones skip without cached weights, and
`packages/db/src/prod-schema.test.ts` skips when the real library DB is absent.

### Building & Testing

```bash
# Frontend
cd apps/web
pnpm build        # Production build
pnpm test         # vitest run (pnpm test:watch for watch mode)
pnpm typecheck    # vue-tsc --noEmit
pnpm lint         # ESLint with auto-fix (lint:check = no fix)

# Backend
cd server
uv run ruff check src  # Lint Python code
uv run ruff format src # Format Python code
```

### Database

SQLite is embedded — there is no separate DB server. The default DB path is
`<target_dir>/.pictoria/pictoria.sqlite`; override with the `DB_PATH` **environment
variable** (`apps/api` loads no dotenv, so putting it in `server/.env` does nothing).
Schema migrations are plain SQL files in `server/migrations/` and are applied
automatically on startup by the Hono API (`apps/api/src/db.ts` calls
`runMigrations`). Nothing else applies them — the Python worker never opens this DB.

```bash
cd server
# Migrations run on app startup; no manual command needed.
# To create a new one, add a numbered SQL file (use the next free number):
#   migrations/NNNN_<short_description>.sql
# It will be applied (idempotently) on the next process boot.

# Inspect a DB file:
uv run python scripts/inspect_db.py
```

## Architecture

### Backend Structure

> **The one rule everything else follows: all computation in the Python worker, all
> database writes in TS. No exceptions.** The Litestar HTTP server and the Python
> `db/` layer were retired on 2026-08-13; `docs/refactor-monorepo-hono.md` Phase 7
> records the last full parity run that licensed it.

#### Security defaults (the API exposes the whole library, read and write)

- **Loopback only**: `src/index.ts` binds `127.0.0.1` unless `PICTORIA_API_HOST` says otherwise (Node's default would be every interface)
- **Browser gates** (`src/security.ts`, mounted first in `app.ts`): `Host` must be a loopback name or an allowed host (stops DNS rebinding); non-GET/HEAD requests with a foreign `Origin` are refused (stops CSRF via "simple" form/multipart POSTs that CORS never sees); then the CORS allowlist. Defaults allow `http://localhost:4778` / `http://127.0.0.1:4778`; extend with `PICTORIA_ALLOWED_ORIGINS` (comma-separated full origins — their host names join the Host list) and `PICTORIA_ALLOWED_HOSTS` (bare host names, e.g. a reverse proxy). Tests: `security.test.ts`
- **`.pictoria/` is not servable**: image paths come from the client, so `paths.ts`'s `resolveLibraryPath` (used by the image endpoints and upload) requires the resolved path to be inside the library root *and* outside `.pictoria/` (both SQLite files, gallery-dl config, `OPENAI_API_KEY`); anything else is a 404

#### `apps/api` — the HTTP server (Hono, port 4777)

- **src/app.ts**: `createApp({ db, tasks })` — app assembly (CORS, compression, route mounting, `/schema/openapi.json`, the 404 shape); routes read the injected handles as `c.var.db` / `c.var.tasks` (`src/env.ts`'s `AppEnv`, build route modules with `newRoutes()`), never `getDb()`. **src/index.ts**: boot side effects only (migrate, serve, scheduler, sync watcher)
- **Route tests**: `createTestApp()` (`src/testing/app.ts`) gives an in-memory migrated DB (`createTestDb()` from `@pictoria/db`), a temp library dir and a recording `fakeTasks`; hit routes with `app.request()`
- **src/paths.ts**: single source of truth for *where things are* (`targetDir`, `pictoriaDir`, `thumbnailsDir`, `dbPath`, `tasksDbPath`, `migrationsDir`) plus the `isInside`/`resolveInside` containment primitives. Any concrete path a worker needs (image, thumbnail) is computed here and sent in the task payload; the Python side (`server/src/paths.py`) only knows the root and checks containment with `_resolve_inside`. Relative `PICTORIA_TARGET_DIR` / `DB_PATH` / `TASKS_DB_PATH` resolve against the repo root on both sides; `postAbsPath(relPath)` is the one way to build a post's absolute path
- **src/db.ts**: the process-wide SQLite handle; **runs `runMigrations` on first open**
- **src/routes/**: one file per resource — `post-reads` / `post-writes` / `post-list` / `post-counts` (+ `post-shared`), `tags` / `tag-writes`, `images`, `folders`, `annotations` / `annotation-queues` (+ `annotation-shared`), `commands`, `statistics`, `queues` (`/v2/queues/status`), `danbooru-imports` (`/v2/danbooru-imports` jobs)
- **src/security.ts**: the three browser gates — CORS allowlist, `Host` check (DNS rebinding), `Origin` check on writes (CSRF); policy from `PICTORIA_ALLOWED_ORIGINS` / `PICTORIA_ALLOWED_HOSTS`
- **src/read-pool.ts** / **src/read-worker.ts** / **src/read-fns.ts**: a `worker_threads` pool, each thread with its own `SQLITE_OPEN_READONLY` connection, that runs the heavy whole-library reads (vec0 KNN for similar / text search, facet counts) off the event loop. Only functions registered in `read-fns.ts` can be called — it is a whitelist, not a SQL executor; routes get it as `c.var.reads`. `PICTORIA_READ_THREADS=0` runs the same functions in-process
- **src/optimize.ts**: `PRAGMA optimize` (with `analysis_limit = 0`) at boot and hourly, so planner stats track table growth
- **src/danbooru-imports.ts**: in-memory Danbooru import job queue behind `/v2/danbooru-imports` — one job per tag set, imported ids read when the job starts, chunked download + persist
- **src/s3.ts**: hand-written SigV4 presigned URLs — the S3 fallback for `GET /v2/images/original/...` when the local file is missing; credentials read from `server/.env`
- **src/workers.ts**: one `WorkerSpec` per backfill worker (queue, batch, pending scan, payload builder, persist, blacklist policy); worker names live once in `packages/db/src/workers.ts`. **src/scheduler.ts**: the loop skeleton + one generic `runBatch` over those specs; single-post recompute in `routes/commands.ts` reuses the same spec (`runOneShot`). A repository write that makes an old post pending again calls `notifyRepending(sqlite, worker)` (`packages/db/src/repending.ts`) itself — routes never wake loops by hand, and each new such write gets an assertion in `repending.test.ts`; **src/sync.ts**: disk↔`posts` reconciliation + file watching; **src/dedup.ts**: near-duplicate grouping
- **src/queue-status.ts**: per-loop progress bookkeeping behind `GET /v2/queues/status` (the sidebar's sync-status area). Remaining counts come from `packages/db`'s `count*Pending` generators (chunked from the scan water-level), run in the background on one serial chain that yields between chunks — a one-shot count of a whole-library backlog blocks the event loop for ~1.6 s
- **src/log.ts**: `createLogger(scope)` → `{ info, warn, error }`, lines are `HH:MM:SS.mmm LEVEL [scope] …`; info → stdout, warn/error → stderr, `PICTORIA_LOG_LEVEL` (`info`/`warn`/`error`) filters. No bare `console.*` in `apps/api/src` — normal events (listening, scheduler start, sync done, migrations) are `info`, real problems `warn`/`error`; functions that take an injectable `log` (`sync.ts`, `scheduler.ts`, `dedup.ts`) default to their own scope's logger and tests pass a no-op. `packages/db` doesn't log
- **src/scripts/**: one-off maintenance run by hand, never on boot — e.g. `recount-tags.ts` (`tags.post_count` vs `post_has_tag`; dry run by default, `--apply` writes)
- **src/openapi.ts**: the single error shape `ErrorBody` (`{error, detail, issues?}`) and its helpers — `errors(400, 404)` declares an endpoint's error responses, `fail(404, 'PostNotFoundError', detail)` returns one (type-checked against the declaration; it needs no `c`, so guards can build it early), `invalidRequest(c, zodError)` is the 400 for routes that `safeParse` by hand. Handlers that use `errors()` must return `c.json(x, 200)` with an explicit status. Do not hand-roll another shape

#### `packages/db` — data access (the only writer)

- `connection.ts` (sqlite-vec + WAL + FK pragma), `schema.ts`, `migrate.ts`, `filters.ts` (`buildWhere` + column allowlists), `scorers.ts`, `repositories/`, `queries/`

#### `server/` — the Python worker, and nothing else

- **src/worker/**: cairnq entry point (`main.py`), task handlers, the vector codec, the OOM fallback ladder, and the importers
- **src/ai/**: SigLIP 2 embedding, CLIP backbone, waifu / SILVA scorers, captioning
- **src/services/**: `gallery_dl_import`, `silva_dataset_import`, `pixai_tagging` (the Danbooru helpers live in `worker/importers.py`) — fetch/parse helpers only; the worker returns rows and TS writes them.
  `pixai_tagging` is the auto-tagger (`pixai-labs/pixai-tagger-v1.0`, replaced WDTagger 2026-09-22): it returns tags under the *model's* five categories (`style` = artist) and TS maps them to groups. Its per-category sigmoid thresholds are the one thing that stays in Python — they ship inside the checkpoint's `config.json`. ⚠️ Load it with `from_pretrained(dtype=...)`, never `.to(dtype=...)`: the latter casts the complex RoPE buffers and silently returns wrong tags
- **src/paths.py**: the Python side's root / `.pictoria` / db-path resolution (no per-file layout — that arrives in payloads)
- Task payload/result shapes are pinned by `packages/contracts/fixtures/tasks/*.json`, read by both `packages/contracts/src/tasks.test.ts` and `server/tests/test_task_contracts.py`; a field renamed on one side fails both suites. `sqlite3` is banned under `server/src` by ruff (TID251)
- **src/tools/**, **src/utils.py**, **src/shared.py**: colour quantisation, hashing/thumbnails, logging
- **migrations/**: hand-written ordered SQL (`0001_initial.sql`, ...). Applied by **`apps/api`** on boot

### Frontend Structure

- **src/App.vue**: Root component with 3-panel splitpanes layout
- **src/views/**: Page components (Home, Post, Settings, etc.)
- **src/components/**: Reusable feature components and mixed-boundary wrappers (`ToastSystem`, `UndoSnackbar`, `TagSelectorWindow`, …) that bind a primitive to global app state
- **src/ui/**: the in-house design-system primitives (`P*.vue`) (`PButton`, `PInput`, `PMenu`, `PSwitch`, `PDialog`, `PPopover`, `PToast`/`PToastContainer`, the virtualised `PTreeList` powering the sidebar folder tree, …) plus `modal.ts` (shared `openDialogCount`), all styled with `--p-*` CSS variables + scoped styles and exported from `index.ts` (these replaced the former `@roku-ui` dependency). See `apps/web/docs/design-system.md`
- **src/api/**: Auto-generated API client from OpenAPI schema
- **src/composables/**: Vue composables for shared logic
- **src/shared/**: Global state and utilities
- **src/locale/**: i18n — vue-i18n instance + locale state (`localeSetting`/`resolvedLocale`, persisted as `pictoria.locale`, `auto` follows the browser) and locale-aware `formatNumber`/`formatDateTime`; message catalogues in `messages/en.ts` (schema source) and `messages/zh-Hans.ts` (typed as `MessageSchema` so key drift fails vue-tsc)

### Key Patterns

- **API**: Hono route handlers call `packages/db` repositories directly; `better-sqlite3` is synchronous, so there is one read-write connection per process (the single writer); the only extra connections are the read-only ones in `read-pool.ts`. Raw SQL strings, no ORM in the query path. FK `ON DELETE CASCADE` is real and enforced (`PRAGMA foreign_keys = ON`) — the manual cascade is `post_vectors_siglip2` (a `vec0` virtual table that doesn't participate in FK cascades; `deleteManyReturningPaths` clears it explicitly)
- **Worker**: a cairnq handler takes a payload with absolute paths, computes, and returns plain data. It opens no connection to `pictoria.sqlite` — that invariant is what keeps a single writer
- **Frontend**: Composition API, TanStack Query for server state, composables for logic reuse
- **Database**: Embedded SQLite (WAL) with `sqlite-vec`; `post_vectors_siglip2` (`FLOAT[1152]`, SigLIP 2) is a `vec0` virtual table (cosine); `posts.dominant_color` is a serialized `FLOAT[3]` BLOB queried by brute-force `vec_distance_L2` (no index — a full scan is ~450 ms at 375k posts; measured 2026-11-10); `GENERATED ALWAYS AS ... VIRTUAL` columns for `posts.full_path` and `posts.aspect_ratio`; `INTEGER PRIMARY KEY AUTOINCREMENT` IDs
- **API**: OpenAPI-based code generation for type-safe client-server communication

## Database Schema

- **posts**: Main image entity with metadata, dimensions, ratings; `dominant_color` is a serialized `FLOAT[3]` (Lab) BLOB (no index); `full_path` and `aspect_ratio` are `GENERATED ALWAYS AS ... VIRTUAL` columns; `arthash` (TEXT placeholder-image hash, renamed from `thumbhash` in migrations `0003`/`0004`); `last_accessed_at` (TEXT, indexed, backs the Recently view, migration `0003`)
- **tags** & **tag_groups**: Hierarchical tagging system; `tags.post_count` is a denormalised per-tag count maintained by AFTER INSERT/DELETE triggers on `post_has_tag` (migration `0008`), backing the tag-filter facet counts
- **post_has_tag**: Many-to-many relationship (FK `ON DELETE CASCADE` to `posts.id` / `tags.name`)
- **post_vectors_siglip2**: 1152-dim SigLIP 2 image embeddings (`vec0` virtual table, `FLOAT[1152]`, cosine); the sole search/retrieval embedding (image-to-image + text-to-image). CLIP retrieval and its `post_vectors` table were removed (see migration `0007_drop_post_vectors.sql`). CLIP ViT-L/14 survives only as the waifu-scorer backbone (`ai/clip.py` → `ai/waifu_scorer.py`)
- **post_waifu_scores**: legacy single-scorer quality scores; **post_aesthetic_scores**: generic per-(post, scorer) scores. Every scorer living in it is declared once in `SCORERS` (`packages/db/src/scorers.ts`) (`silva`, `silva_luna` — two distilled judges sharing `ai/silva_scorer.py`, the same [0,1] domain and the same A–E bucket edges); folder aggregates, bucket-count endpoints, filter fields and backfill loops are generated from it. Adding one is: a `SCORERS` entry, its name in contracts' `SILVA_SCORERS`, its repo id in `ai/silva_scorer.py`'s `REPO_IDS`, the frontend `shared/scorers.ts` entry + i18n — tests/vue-tsc fail on any of them drifting — never a migration
- **post_has_color**: Dominant color palette (per-post `INT` colors with order)
- **post_process_failures**: per-(post, worker) one-shot failure blacklist
- **_schema_versions**: internal table used by `packages/db`'s `runMigrations` to track applied migrations

## Development Guidelines

### When modifying the backend

1. If the schema changes: add a new numbered SQL file to `server/migrations/` (e.g. `NNNN_add_foo.sql`, using the next free number). It is applied on the next process boot; do not edit existing migration files.
2. Update `packages/db/src/schema.ts`, the relevant file under `packages/db/src/repositories/` or `queries/`, and any filter fields / column allowlists in `packages/db/src/filters.ts`.
3. Update or add the endpoint under `apps/api/src/routes/`. Declare error statuses with `errors()` and return them with `fail()` from `src/openapi.ts`; JSON bodies are camelCase (URL params stay snake_case); paths go through `src/paths.ts`.
4. Regenerate the frontend API client: `pnpm genapi` — or `pnpm contract:check`, which regenerates and then fails if the committed client had drifted. Both need the API running.
5. Run checks: `pnpm check` (or at least `pnpm -r test` and `pnpm typecheck`).

### When modifying the worker

1. Compute in the handler, return plain data — **never** write to `pictoria.sqlite`. The
   caller in `apps/api` persists it.
2. Task payload shapes are declared once in `packages/contracts/src/tasks.ts` and mirrored
   in the Python handler; change both.
3. Run checks: `uv run ruff check src scripts tests` and `uv run pytest` (from `server/`), or `pnpm check` from the root.

Notes when writing SQL for SQLite:
- FK `ON DELETE CASCADE` works and is enforced per-connection (`PRAGMA foreign_keys = ON`); rely on it for child tables. The exception is `post_vectors_siglip2` (a `vec0` virtual table) — delete its rows explicitly.
- IDs use `INTEGER PRIMARY KEY AUTOINCREMENT`.
- The `sqlite-vec` extension is loaded on every connection by `packages/db/src/connection.ts`, so `vec0` virtual tables and `vec_distance_L2` / `MATCH ... k = N` KNN queries are available.

### When modifying the frontend

1. Follow Vue 3 Composition API patterns
2. Use existing composables from `src/composables/`
3. Maintain three-panel layout structure
4. Use UnoCSS for styling and follow `apps/web/docs/design-system.md` — tokens only from `--p-*` (no hardcoded hex), floating panels use the `p-popover-panel` shortcut, shadows for floating layers only (`sm`/`md`, no `shadow-lg`), no gradients, no nested panels; new reusable UI primitives go in `src/ui` with a `P` prefix and an `index.ts` export. `src/test/design.test.ts` enforces the hex / z-index / gradient / shadow rules
5. No hardcoded user-visible strings — every label/placeholder/aria/toast goes through vue-i18n: `$t('…')` in templates, `useI18n()` in `<script setup>`, `i18n.global.t` in non-component modules; static option arrays store message *keys* (`labelKey`) resolved at render. Add new keys to **all three** of `src/locale/messages/en.ts`, `zh-Hans.ts` and `zh-Hant.ts` (zh-Hant starts as an OpenCC `s2tw` conversion of zh-Hans, then gets Taiwanese wording — 載入/設定/檔案, not 加載/設置/文件; a test enforces that list) — `src/test/locale.test.ts` fails on key-tree drift, on zh-only interpolation params, and on any literal key used in source that's missing from the catalogue. Numbers/dates use `formatNumber`/`formatDateTime` from `@/locale` (never `Intl.NumberFormat('en-US')` or bare `toLocaleString()`). Tag display names are translated server-side: pass `lang: resolvedLocale.value` to those endpoints and include `resolvedLocale` in the TanStack queryKey so a language switch refetches
6. Run linting before commit: `pnpm lint`

### API Client Generation

After any backend API changes, regenerate the TypeScript client:

```bash
pnpm genapi
```

This ensures type safety between frontend and backend.

### Testing

- Frontend tests use Vitest: `cd apps/web && pnpm test` (or `pnpm test` from the root)
- API / db: `pnpm -r test` (vitest). `packages/db/src/filters.test.ts` pins `buildWhere`'s SQL text against a **frozen** golden dumped from the retired Python reference — it is deterministic, so it never goes stale; it also cannot be regenerated
- Worker: `uv run ruff check src scripts tests` (lint) and `uv run pytest` from `server/`. Pyright is not a dev dependency and not run by `pnpm check` / CI — `[tool.pyright]` in `pyproject.toml` only configures the IDE's Pyright / Pylance
- Contract: `pnpm contract:check` regenerates `apps/web/src/api` from a running API and fails if the result differs from what is committed. That is the whole guard, and it works because the generated client is in the repo: a contract change shows up in its diff, and any call site that did not follow it fails `vue-tsc` during `pnpm build`. The failure it catches is the one nothing else does — changing a route and forgetting to run `pnpm genapi`, which compiles clean and 404s at runtime. On failure the regenerated files are already in the working tree; read the diff, then commit it.

## Important Configuration Files

- **server/pyproject.toml**: Python dependencies and tool settings
- **server/.env**: local secrets only — S3 credentials (read by `apps/api/src/s3.ts`) and Danbooru API keys (read by the worker via python-dotenv); template in `server/.env.example`. Path overrides (`DB_PATH`, `TASKS_DB_PATH`, `PICTORIA_TARGET_DIR`) are **environment variables**, not `.env` entries: `apps/api` loads no dotenv, so a `DB_PATH` here would reach the worker but not the API
- **server/migrations/*.sql**: Ordered, idempotent schema migrations (applied at startup)
- **apps/web/vite.config.ts**: Vite build configuration
- **apps/web/uno.config.ts**: UnoCSS styling configuration
- **pnpm-workspace.yaml**: workspace roots (`apps/*`, `packages/*`). Do NOT add `better-sqlite3`/`sharp` to `onlyBuiltDependencies` — they ship prebuilds; approving their scripts triggers a node-gyp build that fails without MSVC
