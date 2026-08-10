default:
    just --list

# ---- 日常开发：三个进程 ----

# Hono API，占住前端硬编码的 4777。70 个端点全在它这儿，反向代理已经删掉。
api-dev:
    pnpm --filter @pictoria/api dev

# cairnq worker：拥有 GPU 的那个进程。它**只**开 tasks.sqlite，一行 pictoria.sqlite
# 都不碰（见 docs/refactor-monorepo-hono.md §D1）。所有模型推理、缩略图、旋转、
# 两个导入器都在这里；落库一律回到 TS。
worker-dev:
    cd server && uv run ./src/worker/main.py --target_dir ./illustration/images

web-dev:
    pnpm dev

dev:
    (trap 'kill 0' SIGINT; just api-dev & just worker-dev & just web-dev & wait)

# ---- 对拍用的参照实现 ----

# 退役的 Litestar 后端，跑在 4779。**不服务任何流量** —— 它存在的唯一理由是
# `pnpm parity:all` 拿它当基准（同一个请求打两边，逐字段比）。要跑对拍就先起它。
#
# PICTORIA_SKIP_WORKERS 列出全部六个 worker：它们现在由 TS 调度器挑活、Python
# cairnq worker 干活，这个进程不能再自己扫 pending，否则两边对同一批数据重复烧 GPU。
server-ref:
    cd server && PICTORIA_PORT=4779 PICTORIA_SKIP_WORKERS=basics,silva,silva_luna,waifu,tagger,embedding uv run ./src/app.py --target_dir ./illustration/images

# 契约安全网：拿运行中的 Hono 和 docs/openapi.baseline.json 比对。
contract-diff:
    pnpm contract:diff

# 全套对拍。需要 api-dev + worker-dev + server-ref 三个都在跑。
parity:
    pnpm parity:all
