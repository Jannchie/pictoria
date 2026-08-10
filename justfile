default:
    just --list

# 迁移期间：Litestar 退到 4779，Hono 占住前端硬编码的 4777 并把未迁移的
# 路由透传给它（见 docs/refactor-monorepo-hono.md §5 Phase 3）。
server-dev:
    cd server && PICTORIA_PORT=4779 uv run ./src/app.py --target_dir ./illustration/images

# 不走代理，Litestar 直接占 4777。代理本身出问题时用它二分定位。
server-dev-direct:
    cd server && uv run ./src/app.py --target_dir ./illustration/images

api-dev:
    pnpm --filter @pictoria/api dev

web-dev:
    pnpm dev

web-genapi:
    pnpm genapi

# 契约安全网：拿运行中的后端和 docs/openapi.baseline.json 比对。
# 迁移期间每搬完一组端点都要跑（见 docs/refactor-monorepo-hono.md §4.2）。
contract-diff:
    pnpm contract:diff

dev:
    (trap 'kill 0' SIGINT; just server-dev & just api-dev & just web-dev & wait)
