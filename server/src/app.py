import os
import pathlib
import re
import tomllib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pillow_avif  # noqa: F401
from dotenv import load_dotenv
from litestar import Litestar, Router
from litestar.config.compression import CompressionConfig
from litestar.config.cors import CORSConfig
from litestar.connection import Request
from litestar.datastructures import State
from litestar.handlers.http_handlers import HTTPRouteHandler
from litestar.openapi import OpenAPIConfig
from litestar.openapi.plugins import ScalarRenderPlugin
from litestar.plugins.pydantic import PydanticPlugin
from litestar.types import Method, Scope
from litestar.types.internal_types import PathParameterDefinition
from rich import get_console

import shared
from db import DB, run_migrations
from db.repositories.posts import PostRepo
from db.repositories.tags import TagGroupRepo, TagRepo
from db.repositories.vectors import VectorRepo
from server.commands import CommandController
from server.folders import FoldersController
from server.images import ImageController
from server.posts import PostController
from server.statistics import StatisticsController
from server.tags import TagsController
from utils import initialize, logger, parse_arguments

console = get_console()

with pathlib.Path("pyproject.toml").open("rb") as f:
    pyproject = tomllib.load(f)

MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "migrations"


@asynccontextmanager
async def my_lifespan(app: Litestar):
    load_dotenv()
    args = parse_arguments()
    initialize(target_dir=args.target_dir)

    db_path_env = os.environ.get("DB_PATH")
    db_path = pathlib.Path(db_path_env) if db_path_env else (shared.pictoria_dir / "pictoria.duckdb")
    memory_limit = os.environ.get("DUCKDB_MEMORY_LIMIT", "4GB")
    threads = int(os.environ.get("DUCKDB_THREADS", "4"))

    logger.info(f"Opening DuckDB at {db_path}")
    db = DB(db_path, memory_limit=memory_limit, threads=threads)
    run_migrations(db.cursor(), MIGRATIONS_DIR)
    app.state.db = db

    host = "localhost"
    port = 4777
    doc_url = f"http://{host}:{port}/schema"
    logger.info(f"API Document: {doc_url}")
    try:
        yield
    finally:
        db.close()


async def provide_post_repo(state: State) -> AsyncGenerator[PostRepo, None]:
    cur = state.db.cursor()
    try:
        yield PostRepo(cur)
    finally:
        cur.close()


async def provide_tag_repo(state: State) -> AsyncGenerator[TagRepo, None]:
    cur = state.db.cursor()
    try:
        yield TagRepo(cur)
    finally:
        cur.close()


async def provide_tag_group_repo(state: State) -> AsyncGenerator[TagGroupRepo, None]:
    cur = state.db.cursor()
    try:
        yield TagGroupRepo(cur)
    finally:
        cur.close()


async def provide_vector_repo(state: State) -> AsyncGenerator[VectorRepo, None]:
    cur = state.db.cursor()
    try:
        yield VectorRepo(cur)
    finally:
        cur.close()


v2 = Router(
    path="/v2",
    route_handlers=[PostController, CommandController, ImageController, TagsController, FoldersController, StatisticsController],
)

SEPARATORS_CLEANUP_PATTERN = re.compile(r"[!#$%&'*+\-.^_`|~:]+")


def default_operation_id_creator(
    route_handler: HTTPRouteHandler,
    http_method: Method,
    path_components: list[str | PathParameterDefinition],
) -> str:
    handler_namespace = http_method.title() + route_handler.handler_name.title() if len(route_handler.http_methods) > 1 else route_handler.handler_name.title()
    return SEPARATORS_CLEANUP_PATTERN.sub("", f"{path_components[0]}{handler_namespace}")


cors_config = CORSConfig(allow_origins=["*"])


async def log_unhandled_exception(exc: Exception, scope: Scope) -> None:
    request = Request(scope)
    logger.exception(
        "Unhandled exception in %s %s: %r",
        request.method,
        request.url.path,
        exc,
    )


app = Litestar(
    [v2],
    dependencies={
        "posts": provide_post_repo,
        "tag_repo": provide_tag_repo,
        "tag_group_repo": provide_tag_group_repo,
        "vectors": provide_vector_repo,
    },
    lifespan=[my_lifespan],
    debug=True,
    logging_config=None,
    after_exception=[log_unhandled_exception],
    openapi_config=OpenAPIConfig(
        render_plugins=[ScalarRenderPlugin()],
        title="Pictoria",
        version="0.1.0",
        operation_id_creator=default_operation_id_creator,
        use_handler_docstrings=True,
    ),
    compression_config=CompressionConfig(backend="gzip"),
    plugins=[PydanticPlugin(prefer_alias=True)],
    cors_config=cors_config,
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=4777, reload=True, reload_dirs=["src"], reload_excludes=[".venv"], log_config=None)  # noqa: S104
