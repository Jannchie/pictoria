default:
    just --list

server-dev:
    cd server && uv run ./src/app.py --target_dir ./illustration/images

web-dev:
    cd web && pnpm dev

web-genapi:
    cd web && pnpm genapi

dev:
    (trap 'kill 0' SIGINT; just server-dev & just web-dev & wait)