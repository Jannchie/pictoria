default:
    just --list

# 迁移期间：Litestar 退到 4779，Hono 占住前端硬编码的 4777 并把未迁移的
# 路由透传给它（见 docs/refactor-monorepo-hono.md §5 Phase 3）。
# PICTORIA_SKIP_WORKERS 是 Phase 5/6 的迁移缝：列在里面的 worker 由 TS 调度器
# 挑活、Python cairnq worker 干活（见 docs/refactor-monorepo-hono.md §D2），
# 这个进程就不再自己扫它们的 pending —— 否则两边会对同一批数据重复烧 GPU。
server-dev:
    cd server && PICTORIA_PORT=4779 PICTORIA_SKIP_WORKERS=silva,silva_luna,waifu,tagger,embedding uv run ./src/app.py --target_dir ./illustration/images

# 不走代理，Litestar 直接占 4777。代理本身出问题时用它二分定位。
server-dev-direct:
    cd server && uv run ./src/app.py --target_dir ./illustration/images

api-dev:
    pnpm --filter @pictoria/api dev

# cairnq worker：拥有 GPU 的那个进程。它**只**开 tasks.sqlite，一行 pictoria.sqlite
# 都不碰（§D1）。
worker-dev:
    cd server && uv run ./src/worker/main.py --target_dir ./illustration/images

web-dev:
    pnpm dev

web-genapi:
    pnpm genapi

# 契约安全网：拿运行中的后端和 docs/openapi.baseline.json 比对。
# 迁移期间每搬完一组端点都要跑（见 docs/refactor-monorepo-hono.md §4.2）。
contract-diff:
    pnpm contract:diff

dev:
    (trap 'kill 0' SIGINT; just server-dev & just api-dev & just worker-dev & just web-dev & wait)
