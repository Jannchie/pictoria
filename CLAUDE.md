# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pictoria is a full-stack image gallery application for managing and displaying images, particularly AI-generated art. It features automatic tagging, vector-based similarity search, and quality scoring.

## Tech Stack

- **Backend**: Python 3.12+ with Litestar framework, embedded SQLite (WAL) + `sqlite-vec` (vec0 virtual tables for vector search), Pydantic entities, hand-written Repository + query-service layer (no ORM)
- **Frontend**: Vue 3 with Composition API, Vite, UnoCSS, TypeScript
- **Package Managers**: `uv` for Python, `pnpm` for JavaScript

## Essential Commands

### Development

```bash
# Run full application (backend + frontend)
just dev

# Run backend only
just server-dev
# Or directly:
uv run ./src/app.py --target_dir ./illustration/images

# Run frontend only
just web-dev
# Or directly:
cd web && pnpm dev

# Generate API client after backend changes
just web-genapi
# Or directly:
cd web && pnpm genapi
```

### Building & Testing

```bash
# Frontend
cd web
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
automatically on startup by `db.migrator.run_migrations`.

```bash
cd server
# Migrations run on app startup; no manual command needed.
# To create a new one, add a numbered SQL file:
#   migrations/0002_<short_description>.sql
# It will be applied (idempotently) on the next process boot.

# Inspect a DB file:
uv run python scripts/inspect_db.py

# Clean junk tags (legacy maintenance):
uv run python scripts/tags/clean_tags.py
```

## Architecture

### Backend Structure

- **src/app.py**: Main Litestar application entry point (DI wires repositories per request)
- **src/db/**: Data access layer:
  - `connection.py`: `DB` class — owns thread-local SQLite connections (each with `sqlite-vec` loaded + WAL), hands out per-thread cursors
  - `entities.py`: Pydantic models that map 1:1 to DB rows (Post, Tag, TagGroup, ...)
  - `migrator.py`: SQL-file migration runner; tracks applied versions in `_schema_versions`
  - `filters.py`: `PostFilter` / `PostFilterWithOrder` value objects, `build_where()`, and the centralized column allowlists (orderable / updatable / groupable)
  - `repositories/`: Focused async row repositories (`PostRepo` = posts-table CRUD, `TagRepo`, `TagGroupRepo`, `ScoreRepo`, `ColorRepo`, `FailureRepo`, `VectorRepo`); each public method wraps a sync SQLite call in `asyncio.to_thread`
  - `queries/`: `PostQueryService` — the read side (detail/list/search assembly + filtered counts/aggregates), composing the focused repos for per-table batch fetches
- **migrations/**: Hand-written, ordered SQL migration files (`0001_initial.sql`, ...)
- **src/server/**: API controllers organized by resource:
  - `posts.py`: Image CRUD operations, batch updates
  - `tags.py`: Tag management and grouping
  - `images.py`: Image serving and thumbnails
  - `folders.py`: Directory traversal and sync
  - `statistics.py`: Analytics and metrics
- **src/ai/**: AI integration for tagging and scoring
- **src/services/**: Business logic layer (file sync, waifu scorer, S3 client)

### Frontend Structure

- **src/App.vue**: Root component with 3-panel splitpanes layout
- **src/views/**: Page components (Home, Post, Settings, etc.)
- **src/components/**: Reusable feature/UI components
- **src/ui/**: In-house design-system primitives (`PButton`, `PInput`, `PMenu`, `PSwitch`, …) styled with `--p-*` CSS variables + scoped styles; auto-registered alongside `src/components` (these replaced the former `@roku-ui` dependency)
- **src/api/**: Auto-generated API client from OpenAPI schema
- **src/composables/**: Vue composables for shared logic
- **src/shared/**: Global state and utilities
- **src/roku/**: Larger in-house components (`TreeList`, `Collapse`, `Image`, `AutoHeightTransition`)

### Key Patterns

- **Backend**: Litestar `async def` handlers; reads inject `PostQueryService`, writes inject the focused repos. Sync DB methods bridged by `asyncio.to_thread`; raw SQL strings, no ORM. FK `ON DELETE CASCADE` is real and enforced (`PRAGMA foreign_keys = ON` per connection) — the manual cascade is `post_vectors_siglip2` (a `vec0` virtual table that doesn't participate in FK cascades; `PostRepo.delete_many` clears it explicitly)
- **Frontend**: Composition API, TanStack Query for server state, composables for logic reuse
- **Database**: Embedded SQLite (WAL) with `sqlite-vec`; `post_vectors_siglip2` (`FLOAT[1152]`, SigLIP 2) is a `vec0` virtual table (cosine); `posts.dominant_color` is a serialized `FLOAT[3]` BLOB queried by brute-force `vec_distance_L2` (no index — a 3-d scan is sub-millisecond); `GENERATED ALWAYS AS ... VIRTUAL` columns for `posts.full_path` and `posts.aspect_ratio`; `INTEGER PRIMARY KEY AUTOINCREMENT` IDs
- **API**: OpenAPI-based code generation for type-safe client-server communication

## Database Schema

- **posts**: Main image entity with metadata, dimensions, ratings; `dominant_color` is a serialized `FLOAT[3]` (Lab) BLOB (no index); `full_path` and `aspect_ratio` are `GENERATED ALWAYS AS ... VIRTUAL` columns
- **tags** & **tag_groups**: Hierarchical tagging system
- **post_has_tag**: Many-to-many relationship (FK `ON DELETE CASCADE` to `posts.id` / `tags.name`)
- **post_vectors_siglip2**: 1152-dim SigLIP 2 image embeddings (`vec0` virtual table, `FLOAT[1152]`, cosine); the sole search/retrieval embedding (image-to-image + text-to-image). CLIP retrieval and its `post_vectors` table were removed (see migration `0007_drop_post_vectors.sql`). CLIP ViT-L/14 survives only as the waifu-scorer backbone (`ai/clip.py` → `ai/waifu_scorer.py`)
- **post_waifu_scores**: legacy single-scorer quality scores; **post_aesthetic_scores**: generic per-(post, scorer) scores (e.g. `siglip-v2-5`)
- **post_has_color**: Dominant color palette (per-post `INT` colors with order)
- **post_process_failures**: per-(post, worker) one-shot failure blacklist
- **_schema_versions**: internal table used by `db.migrator` to track applied migrations

## Development Guidelines

### When modifying the backend

1. If the schema changes: add a new numbered SQL file to `server/migrations/` (e.g. `0002_add_foo.sql`). It is applied on the next process boot; do not edit existing migration files.
2. Update the matching Pydantic entity in `src/db/entities.py`. Put **write** logic on the relevant focused repo (`PostRepo`/`ScoreRepo`/`ColorRepo`/`TagRepo`/...); put **read** logic (assembly, filtered counts/aggregates) on `PostQueryService`; add filter fields / column allowlists in `db/filters.py`.
3. Update API endpoints in `src/server/` (reads inject `PostQueryService`, writes inject the focused repo).
4. Regenerate frontend API client: `just web-genapi`
5. Run checks: `uv run ruff check src` and `uv run pytest`.

Notes when writing SQL for SQLite:
- FK `ON DELETE CASCADE` works and is enforced per-connection (`PRAGMA foreign_keys = ON`); rely on it for child tables. The exception is `post_vectors_siglip2` (a `vec0` virtual table) — delete its rows explicitly.
- IDs use `INTEGER PRIMARY KEY AUTOINCREMENT`.
- The `sqlite-vec` extension is loaded on every connection by `DB._new_connection`, so `vec0` virtual tables and `vec_distance_L2` / `MATCH ... k = N` KNN queries are available.

### When modifying the frontend

1. Follow Vue 3 Composition API patterns
2. Use existing composables from `src/composables/`
3. Maintain three-panel layout structure
4. Use UnoCSS (`presetWind4` + `presetIcons`) for styling; UI primitives live in `src/ui` and read design tokens from `--p-*` CSS variables (no external component library)
5. Run linting before commit: `pnpm lint`

### API Client Generation

After any backend API changes, regenerate the TypeScript client:

```bash
cd web && pnpm genapi
```

This ensures type safety between frontend and backend.

### Testing

- Frontend tests use Vitest: `cd web && pnpm test`
- Backend: `uv run ruff check src` (lint), Pyright (types), and `uv run pytest` — a golden-master characterization suite in `server/tests/` pins the data-access layer's behaviour (run it before/after any repository or query change)

## Important Configuration Files

- **server/pyproject.toml**: Python dependencies and tool settings
- **server/.env**: Local DB/runtime overrides — `DB_PATH`, S3 credentials
- **server/migrations/*.sql**: Ordered, idempotent schema migrations (applied at startup)
- **web/vite.config.ts**: Vite build configuration
- **web/uno.config.ts**: UnoCSS styling configuration
