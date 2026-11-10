[![CodeTime Badge](https://shields.jannchie.com/endpoint?style=social&color=222&url=https%3A%2F%2Fapi.codetime.dev%2Fv3%2Fusers%2Fshield%3Fuid%3D2%26project%3Dpictoria)](https://codetime.dev)

# Pictoria

Pictoria is a full-stack image gallery application designed for managing and displaying images, with a focus on AI-generated art: automatic tagging, vector similarity search (SigLIP 2 + `sqlite-vec`) and quality scoring.

It is three processes:

* **API** — TypeScript on [Hono](https://hono.dev) (`apps/api`), the only process that reads and writes the embedded SQLite library database.
* **Worker** — Python under [cairnq](https://pypi.org/project/cairnq/) (`server/`), owns the GPU and only computes (embeddings, tags, scores, imports); it never opens the database.
* **Frontend** — Vue 3 + Vite (`apps/web`).

## Getting Started

### Prerequisites

* Node.js 24 and `pnpm` (version pinned by `packageManager` in `package.json`)
* Python 3.12 and `uv`
* An NVIDIA GPU for the worker (the API and frontend run without one)

### Installation & Running

1. **Clone and install:**

    ```bash
    git clone git@github.com:Jannchie/pictoria.git
    cd pictoria
    pnpm install
    cd server && uv sync && cd ..
    ```

2. **Run the development environment.** One command from the project root starts all three processes:

    ```bash
    pnpm dev
    ```

    Or run them separately:

    * **API (Hono, port 4777):** `pnpm dev:api`
    * **Worker (cairnq, owns the GPU):** `pnpm dev:worker`
    * **Frontend (Vite, port 4778):** `pnpm dev:web`

    The library defaults to `server/illustration/images`; set `PICTORIA_TARGET_DIR` (an environment variable, relative paths resolve against the repo root) to point elsewhere. The database lives in `<library>/.pictoria/pictoria.sqlite` and its migrations run automatically when the API starts.

3. **Optional secrets** (Danbooru API key, S3 fallback): copy `server/.env.example` to `server/.env`.

### Checks

```bash
pnpm check   # typecheck + tests + lint (no --fix) + ruff + pytest — the same set CI runs
```

## Security defaults

The API exposes the whole library (read and write), so it is locked to the local machine by default:

* It binds `127.0.0.1` only. `PICTORIA_API_HOST` changes that (e.g. `0.0.0.0` for LAN access).
* Browser requests pass three gates: a CORS allowlist, a `Host` header check (against DNS rebinding) and an `Origin` check on writes (against CSRF). The defaults allow the dev frontend at `http://localhost:4778` / `http://127.0.0.1:4778`. Opening the frontend from another origin needs `PICTORIA_ALLOWED_ORIGINS` (comma-separated full origins); a reverse proxy can add bare host names with `PICTORIA_ALLOWED_HOSTS`.
* The image endpoints refuse anything under the library's `.pictoria/` directory (database, gallery-dl config, keys).

## Backups

Don't copy `pictoria.sqlite` while the API is running (it is in WAL mode). Use `server/scripts/backup_db.py`, which writes a consistent `VACUUM INTO` snapshot and can upload it with rclone — usage and restore steps are in [`scripts/README.md`](scripts/README.md).
