default:
    just --list

server-dev:
    cd server && uv run ./src/main.py --target_dir demo

web-dev:
    cd web && pnpm dev

web-genapi:
    cd web && pnpm genapi
    
web-genapi2:
    cd web && pnpm genapi2