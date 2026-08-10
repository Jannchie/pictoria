default:
    just --list

server-dev:
    cd server && uv run ./src/app.py --target_dir ./illustration/images

web-dev:
    pnpm dev

web-genapi:
    pnpm genapi

# 契约安全网：拿运行中的后端和 docs/openapi.baseline.json 比对。
# 迁移期间每搬完一组端点都要跑（见 docs/refactor-monorepo-hono.md §4.2）。
contract-diff:
    pnpm contract:diff

dev:
    (trap 'kill 0' SIGINT; just server-dev & just web-dev & wait)