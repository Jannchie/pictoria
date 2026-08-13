# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pictoria is a full-stack image gallery application for managing and displaying images, particularly AI-generated art. It features automatic tagging, vector-based similarity search, and quality scoring.

## Tech Stack

- **API**: TypeScript on Hono (`apps/api`), embedded SQLite (WAL) + `sqlite-vec` (vec0 virtual tables for vector search), hand-written repositories in `packages/db` (raw SQL, no ORM)
- **Worker**: Python 3.11+ (dev pins 3.12) running under [cairnq](https://pypi.org/project/cairnq/) (`server/src/worker`). It **computes only** — torch / wdtagger / gallery-dl are the reason it exists. It never opens `pictoria.sqlite`
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

⚠️ Do **not** rewrite it as a POSIX `(trap 'kill 0' SIGINT; a & b & wait)` one-liner.
`pnpm config get script-shell` reports msys bash on this machine, but root scripts
actually execute under cmd.exe — `trap` and `wait` come back "not recognized", the
parent exits immediately, and the children die with it. Measured, not assumed.

### Building & Testing

```bash
# Frontend
cd apps/web
pnpm build        # Production build
pnpm test         # Run vitest tests
pnpm lint         # ESLint with auto-fix

# Backend
cd server
uv run ruff check src  # Lint Python code
uv run ruff format src # Format Python code
```

### Database

SQLite is embedded — there is no separate DB server. The default DB path is
`<target_dir>/.pictoria/pictoria.sqlite`; override with `DB_PATH` in `.env`.
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

#### `apps/api` — the HTTP server (Hono, port 4777)

- **src/index.ts**: app assembly — CORS, compression, route mounting, `/schema/openapi.json`, the 404 shape, and the backfill scheduler boot
- **src/paths.ts**: single source of truth for *where things are* (`targetDir`, `pictoriaDir`, `thumbnailsDir`, `dbPath`, `tasksDbPath`, `migrationsDir`) plus the `isInside`/`resolveInside` containment primitives. The Python worker has its own copy (`worker/handlers.py`'s `library_root()` / `pictoria_dir()` / `thumbnails_root()`) — a mismatch between them is silent
- **src/db.ts**: the process-wide SQLite handle; **runs `runMigrations` on first open**
- **src/routes/**: one file per resource (posts read/write/list/counts, tags, images, folders, annotations, annotation-queues, commands, statistics)
- **src/scheduler.ts**: picks pending work per worker and submits cairnq tasks; **src/sync.ts**: disk↔`posts` reconciliation + file watching; **src/dedup.ts**: near-duplicate grouping
- **src/openapi.ts**: the two Litestar-compatible error shapes — `domainError` (`{detail, error}`) and `httpError` (`{status_code, detail}`). There are exactly two; do not hand-roll a third

#### `packages/db` — data access (the only writer)

- `connection.ts` (sqlite-vec + WAL + FK pragma), `schema.ts`, `migrate.ts`, `filters.ts` (`buildWhere` + column allowlists), `scorers.ts`, `repositories/`, `queries/`

#### `server/` — the Python worker, and nothing else

- **src/worker/**: cairnq entry point (`main.py`), task handlers, the vector codec, the OOM fallback ladder, and the importers
- **src/ai/**: SigLIP 2 embedding, CLIP backbone, waifu / SILVA scorers, captioning
- **src/services/**: `danbooru_import`, `gallery_dl_import`, `wd_tagging` — fetch/parse helpers only; the worker returns rows and TS writes them
- **src/scorers.py**: the `ScorerSpec` registry. ⚠️ hand-synced twin of `packages/db/src/scorers.ts`
- **src/tools/**, **src/utils.py**, **src/shared.py**: colour quantisation, hashing/thumbnails, logging
- **migrations/**: hand-written ordered SQL (`0001_initial.sql`, ...). Applied by **`apps/api`** on boot

### Frontend Structure

- **src/App.vue**: Root component with 3-panel splitpanes layout
- **src/views/**: Page components (Home, Post, Settings, etc.)
- **src/components/**: Reusable feature components and mixed-boundary wrappers (`ToastSystem`, `UndoSnackbar`, `TagSelectorWindow`, …) that bind a primitive to global app state
- **src/ui/**: ~22 in-house design-system primitives (`PButton`, `PInput`, `PMenu`, `PSwitch`, `PDialog`, `PPopover`, `PToast`/`PToastContainer`, the virtualised `PTreeList` powering the sidebar folder tree, …) plus `modal.ts` (shared `openDialogCount`), all styled with `--p-*` CSS variables + scoped styles and exported from `index.ts` (these replaced the former `@roku-ui` dependency). See `apps/web/docs/design-system.md`
- **src/api/**: Auto-generated API client from OpenAPI schema
- **src/composables/**: Vue composables for shared logic
- **src/shared/**: Global state and utilities
- **src/locale/**: i18n — vue-i18n instance + locale state (`localeSetting`/`resolvedLocale`, persisted as `pictoria.locale`, `auto` follows the browser) and locale-aware `formatNumber`/`formatDateTime`; message catalogues in `messages/en.ts` (schema source) and `messages/zh-Hans.ts` (typed as `MessageSchema` so key drift fails vue-tsc)

### Key Patterns

- **API**: Hono route handlers call `packages/db` repositories directly; `better-sqlite3` is synchronous, so one connection per process is enough (no pool). Raw SQL strings, no ORM. FK `ON DELETE CASCADE` is real and enforced (`PRAGMA foreign_keys = ON`) — the manual cascade is `post_vectors_siglip2` (a `vec0` virtual table that doesn't participate in FK cascades; `deleteManyReturningPaths` clears it explicitly)
- **Worker**: a cairnq handler takes a payload with absolute paths, computes, and returns plain data. It opens no connection to `pictoria.sqlite` — that invariant is what keeps a single writer
- **Frontend**: Composition API, TanStack Query for server state, composables for logic reuse
- **Database**: Embedded SQLite (WAL) with `sqlite-vec`; `post_vectors_siglip2` (`FLOAT[1152]`, SigLIP 2) is a `vec0` virtual table (cosine); `posts.dominant_color` is a serialized `FLOAT[3]` BLOB queried by brute-force `vec_distance_L2` (no index — a 3-d scan is sub-millisecond); `GENERATED ALWAYS AS ... VIRTUAL` columns for `posts.full_path` and `posts.aspect_ratio`; `INTEGER PRIMARY KEY AUTOINCREMENT` IDs
- **API**: OpenAPI-based code generation for type-safe client-server communication

## Database Schema

- **posts**: Main image entity with metadata, dimensions, ratings; `dominant_color` is a serialized `FLOAT[3]` (Lab) BLOB (no index); `full_path` and `aspect_ratio` are `GENERATED ALWAYS AS ... VIRTUAL` columns; `arthash` (TEXT placeholder-image hash, renamed from `thumbhash` in migrations `0003`/`0004`); `last_accessed_at` (TEXT, indexed, backs the Recently view, migration `0003`)
- **tags** & **tag_groups**: Hierarchical tagging system; `tags.post_count` is a denormalised per-tag count maintained by AFTER INSERT/DELETE triggers on `post_has_tag` (migration `0008`), backing the tag-filter facet counts
- **post_has_tag**: Many-to-many relationship (FK `ON DELETE CASCADE` to `posts.id` / `tags.name`)
- **post_vectors_siglip2**: 1152-dim SigLIP 2 image embeddings (`vec0` virtual table, `FLOAT[1152]`, cosine); the sole search/retrieval embedding (image-to-image + text-to-image). CLIP retrieval and its `post_vectors` table were removed (see migration `0007_drop_post_vectors.sql`). CLIP ViT-L/14 survives only as the waifu-scorer backbone (`ai/clip.py` → `ai/waifu_scorer.py`)
- **post_waifu_scores**: legacy single-scorer quality scores; **post_aesthetic_scores**: generic per-(post, scorer) scores. Every scorer living in it is declared once as a `ScorerSpec` in `server/src/scorers.py` (+ its TS twin `packages/db/src/scorers.ts`) (`silva`, `silva_luna` — two distilled judges sharing `ai/silva_scorer.py`, the same [0,1] domain and the same A–E bucket edges); adding one is a registry entry plus a worker, never a migration
- **post_has_color**: Dominant color palette (per-post `INT` colors with order)
- **post_process_failures**: per-(post, worker) one-shot failure blacklist
- **_schema_versions**: internal table used by `packages/db`'s `runMigrations` to track applied migrations

## Development Guidelines

### When modifying the backend

1. If the schema changes: add a new numbered SQL file to `server/migrations/` (e.g. `NNNN_add_foo.sql`, using the next free number). It is applied on the next process boot; do not edit existing migration files.
2. Update `packages/db/src/schema.ts`, the relevant file under `packages/db/src/repositories/` or `queries/`, and any filter fields / column allowlists in `packages/db/src/filters.ts`.
3. Update or add the endpoint under `apps/api/src/routes/`. Errors go through `domainError` / `httpError` from `src/openapi.ts`; paths go through `src/paths.ts`.
4. Regenerate frontend API client: `pnpm genapi`
5. Run checks: `pnpm -r test` and `pnpm --filter @pictoria/api typecheck`, plus `pnpm contract:diff` against a running API if the contract moved.

### When modifying the worker

1. Compute in the handler, return plain data — **never** write to `pictoria.sqlite`. The
   caller in `apps/api` persists it.
2. Task payload shapes are declared once in `packages/contracts/src/tasks.ts` and mirrored
   in the Python handler; change both.
3. Run checks: `uv run ruff check src` and `uv run pytest` (from `server/`).

Notes when writing SQL for SQLite:
- FK `ON DELETE CASCADE` works and is enforced per-connection (`PRAGMA foreign_keys = ON`); rely on it for child tables. The exception is `post_vectors_siglip2` (a `vec0` virtual table) — delete its rows explicitly.
- IDs use `INTEGER PRIMARY KEY AUTOINCREMENT`.
- The `sqlite-vec` extension is loaded on every connection by `packages/db/src/connection.ts`, so `vec0` virtual tables and `vec_distance_L2` / `MATCH ... k = N` KNN queries are available.

### When modifying the frontend

1. Follow Vue 3 Composition API patterns
2. Use existing composables from `src/composables/`
3. Maintain three-panel layout structure
4. Use UnoCSS for styling and follow `apps/web/docs/design-system.md` — tokens only from `--p-*` (no hardcoded hex), floating panels use the `p-popover-panel` shortcut, shadows for floating layers only (`sm`/`md`, no `shadow-lg`), no gradients, no nested panels; new reusable UI primitives go in `src/ui` with a `P` prefix and an `index.ts` export. `src/test/design.test.ts` enforces the hex / z-index / gradient / shadow rules
5. No hardcoded user-visible strings — every label/placeholder/aria/toast goes through vue-i18n: `$t('…')` in templates, `useI18n()` in `<script setup>`, `i18n.global.t` in non-component modules; static option arrays store message *keys* (`labelKey`) resolved at render. Add new keys to **both** `src/locale/messages/en.ts` and `zh-Hans.ts` — `src/test/locale.test.ts` fails on key-tree drift, on zh-only interpolation params, and on any literal key used in source that's missing from the catalogue. Numbers/dates use `formatNumber`/`formatDateTime` from `@/locale` (never `Intl.NumberFormat('en-US')` or bare `toLocaleString()`). Tag display names are translated server-side: pass `lang: resolvedLocale.value` to those endpoints and include `resolvedLocale` in the TanStack queryKey so a language switch refetches
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
- Worker: `uv run ruff check src` (lint), Pyright (types), and `uv run pytest` from `server/`
- Contract: `pnpm contract:diff` compares a running API's `/schema/openapi.json` against `docs/openapi.baseline.json`. This is now the only guard on the 70-endpoint contract — the 12 parity suites that compared against Litestar retired with it

## Important Configuration Files

- **server/pyproject.toml**: Python dependencies and tool settings
- **server/.env**: Local runtime overrides — S3 credentials, Danbooru API keys; optional `DB_PATH` overrides the default `<target_dir>/.pictoria/pictoria.sqlite`
- **server/migrations/*.sql**: Ordered, idempotent schema migrations (applied at startup)
- **apps/web/vite.config.ts**: Vite build configuration
- **apps/web/uno.config.ts**: UnoCSS styling configuration
- **pnpm-workspace.yaml**: workspace roots (`apps/*`, `packages/*`). Do NOT add `better-sqlite3`/`sharp` to `onlyBuiltDependencies` — they ship prebuilds; approving their scripts triggers a node-gyp build that fails without MSVC
