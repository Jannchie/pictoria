# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pictoria is a full-stack image gallery application for managing and displaying images, particularly AI-generated art. It features automatic tagging, vector-based similarity search, and quality scoring.

## Tech Stack

- **Backend**: Python 3.12+ with Litestar framework, PostgreSQL with pgvector, SQLAlchemy 2.0
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

```bash
cd server
# Run migrations
uv run alembic upgrade head

# Create new migration
uv run alembic revision --autogenerate -m "description"
```

## Architecture

### Backend Structure

- **src/app.py**: Main Litestar application entry point
- **src/models.py**: SQLAlchemy models (Posts, Tags, TagGroups, etc.)
- **src/server/**: API controllers organized by resource:
  - `posts.py`: Image CRUD operations, batch updates
  - `tags.py`: Tag management and grouping
  - `images.py`: Image serving and thumbnails
  - `folders.py`: Directory traversal and sync
  - `statistics.py`: Analytics and metrics
- **src/ai/**: AI integration for tagging and scoring
- **src/services/**: Business logic layer
- **alembic/**: Database migrations

### Frontend Structure

- **src/App.vue**: Root component with 3-panel splitpanes layout
- **src/views/**: Page components (Home, Post, Settings, etc.)
- **src/components/**: Reusable UI components
- **src/api/**: Auto-generated API client from OpenAPI schema
- **src/composables/**: Vue composables for shared logic
- **src/shared/**: Global state and utilities
- **src/roku/**: Custom UI component library integration

### Key Patterns

- **Backend**: Async/await throughout, dependency injection via Litestar, RESTful API design
- **Frontend**: Composition API, TanStack Query for server state, composables for logic reuse
- **Database**: PostgreSQL with pgvector for similarity search, computed columns for performance
- **API**: OpenAPI-based code generation for type-safe client-server communication

## Database Schema

- **posts**: Main image entity with metadata, dimensions, ratings
- **tags** & **tag_groups**: Hierarchical tagging system
- **post_has_tag**: Many-to-many relationship
- **post_vector**: Image embeddings for similarity search
- **post_waifu_score**: AI-generated quality scores
- **post_has_color**: Dominant color extraction

## Development Guidelines

### When modifying the backend

1. Update SQLAlchemy models in `src/models.py`
2. Create database migration: `uv run alembic revision --autogenerate -m "description"`
3. Update API endpoints in `src/server/`
4. Regenerate frontend API client: `just web-genapi`
5. Run linting: `uv run ruff check src`

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
- **web/vite.config.ts**: Vite build configuration
- **web/uno.config.ts**: UnoCSS styling configuration
- **server/alembic.ini**: Database migration settings
