# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pictoria is a full-stack image gallery application for managing and displaying images, particularly AI-generated art. It features automatic tagging, vector-based similarity search, and quality scoring.

## Tech Stack

- **Backend**: Python 3.12+ with Litestar framework, embedded DuckDB + VSS (HNSW vector indexes), Pydantic entities, hand-written Repository layer (no ORM)
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

DuckDB is embedded — there is no separate DB server. The default DB path is
`<target_dir>/.pictoria/pictoria.duckdb`; override with `DB_PATH` in `.env`.
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
  - `connection.py`: `DB` class — owns one DuckDB connection, hands out per-cursor configured handles
  - `entities.py`: Pydantic models that map 1:1 to DB rows (Post, Tag, TagGroup, ...)
  - `migrator.py`: SQL-file migration runner; tracks applied versions in `_schema_versions`
  - `repositories/`: Async repositories (`PostRepo`, `TagRepo`, `TagGroupRepo`, `VectorRepo`); each public method wraps a sync DuckDB call in `asyncio.to_thread`
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
- **src/components/**: Reusable UI components
- **src/api/**: Auto-generated API client from OpenAPI schema
- **src/composables/**: Vue composables for shared logic
- **src/shared/**: Global state and utilities
- **src/roku/**: Custom UI component library integration

### Key Patterns

- **Backend**: Litestar `async def` handlers + sync `Repository` methods bridged by `asyncio.to_thread`; raw SQL strings, no ORM; FK constraints are *informational only* in DuckDB so application-layer cascade deletes (see `PostRepo.delete_many`) are required
- **Frontend**: Composition API, TanStack Query for server state, composables for logic reuse
- **Database**: Embedded DuckDB; HNSW indexes via the `vss` extension (cosine on `post_vectors.embedding`, l2sq on `posts.dominant_color`); `GENERATED ALWAYS AS` columns for `posts.full_path` and `posts.aspect_ratio`; sequences for autoincrement IDs (no `setval` — see `migrations/` for the `nextval(...)` pattern)
- **API**: OpenAPI-based code generation for type-safe client-server communication

## Database Schema

- **posts**: Main image entity with metadata, dimensions, ratings; `dominant_color FLOAT[3]` (Lab) with an HNSW index; `full_path` and `aspect_ratio` are `GENERATED ALWAYS AS` columns
- **tags** & **tag_groups**: Hierarchical tagging system
- **post_has_tag**: Many-to-many relationship (logical FK to `posts.id` / `tags.name`)
- **post_vectors**: 768-dim image embeddings (`FLOAT[768]`) with a cosine HNSW index
- **post_waifu_scores**: AI-generated quality scores
- **post_has_color**: Dominant color palette (per-post `INT` colors with order)
- **_schema_versions**: internal table used by `db.migrator` to track applied migrations

## Development Guidelines

### When modifying the backend

1. If the schema changes: add a new numbered SQL file to `server/migrations/` (e.g. `0002_add_foo.sql`). It is applied on the next process boot; do not edit existing migration files.
2. Update the matching Pydantic entity in `src/db/entities.py` and any affected repository methods in `src/db/repositories/`.
3. Update API endpoints in `src/server/`.
4. Regenerate frontend API client: `just web-genapi`
5. Run linting: `uv run ruff check src`

Notes when writing SQL for DuckDB:
- No `ON DELETE CASCADE` / `ON UPDATE CASCADE` — DuckDB rejects them. Do cascades in the repository layer.
- No `setval()` / `ALTER SEQUENCE RESTART`. To advance a sequence past an existing max id, use `SELECT max(nextval('seq_name')) FROM range(N)`.
- HNSW indexes require `SET hnsw_enable_experimental_persistence=true` per connection (already applied by `DB.cursor()`).

### When modifying the frontend

1. Follow Vue 3 Composition API patterns
2. Use existing composables from `src/composables/`
3. Maintain three-panel layout structure
4. Use UnoCSS for styling with @roku-ui preset
5. Run linting before commit: `pnpm lint`

### API Client Generation

After any backend API changes, regenerate the TypeScript client:

```bash
cd web && pnpm genapi
```

This ensures type safety between frontend and backend.

### Testing

- Frontend tests use Vitest: `cd web && pnpm test`
- Backend uses Ruff for linting and Pyright for type checking

## Important Configuration Files

- **server/pyproject.toml**: Python dependencies and tool settings
- **server/.env**: Local DB/runtime overrides — `DB_PATH`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS`, S3 credentials
- **server/migrations/*.sql**: Ordered, idempotent schema migrations (applied at startup)
- **web/vite.config.ts**: Vite build configuration
- **web/uno.config.ts**: UnoCSS styling configuration
