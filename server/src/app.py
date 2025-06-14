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
from litestar.datastructures import State
from litestar.exceptions import ClientException
from litestar.handlers.http_handlers import HTTPRouteHandler
from litestar.openapi import OpenAPIConfig
from litestar.openapi.plugins import ScalarRenderPlugin
from litestar.plugins.pydantic import PydanticPlugin
from litestar.status_codes import HTTP_409_CONFLICT
from litestar.types import Method
from litestar.types.internal_types import PathParameterDefinition
from psycopg import IntegrityError
from rich import get_console
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

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


@asynccontextmanager
async def my_lifespan(_: Litestar):
    load_dotenv()
    args = parse_arguments()
    initialize(target_dir=args.target_dir)
    # await sync_metadata()
    # watch_target_dir()
    host = "localhost"
    port = 4777
    doc_url = f"http://{host}:{port}/schema"
    logger.info(f"API Document: {doc_url}")
    yield


MySession = async_sessionmaker(expire_on_commit=False)


async def provide_async_transaction(state: State) -> AsyncGenerator[AsyncSession, None]:
    async with MySession(bind=state.engine) as session:
        try:
            async with session.begin():
                yield session
        except IntegrityError as e:
            raise ClientException(
                status_code=HTTP_409_CONFLICT,
                detail=str(e),
            ) from e


async def provide_async_session(state: State) -> AsyncGenerator[AsyncSession, None]:
    async with MySession(bind=state.engine) as session:
        try:
            yield session
        except IntegrityError as e:
            raise ClientException(
                status_code=HTTP_409_CONFLICT,
                detail=str(e),
            ) from e
        finally:
            await session.commit()
            await session.close()


@asynccontextmanager
async def db_connection(app: Litestar) -> AsyncGenerator[None, None]:
    engine = getattr(app.state, "engine", None)
    if engine is None:
        db_url = os.environ.get("DB_URL")
        engine = create_async_engine(db_url, echo=False, pool_size=100, max_overflow=200)
        app.state.engine = engine
    try:
        yield
    finally:
        await engine.dispose()


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
    """Create a unique 'operationId' for an OpenAPI PathItem entry.

    Args:
        route_handler: The HTTP Route Handler instance.
        http_method: The HTTP method for the given PathItem.
        path_components: A list of path components.

    Returns:
        A camelCased operationId created from the handler function name,
        http method and path components.
    """
    handler_namespace = http_method.title() + route_handler.handler_name.title() if len(route_handler.http_methods) > 1 else route_handler.handler_name.title()
    return SEPARATORS_CLEANUP_PATTERN.sub("", f"{path_components[0]}{handler_namespace}")


cors_config = CORSConfig(allow_origins=["*"])

app = Litestar(
    [v2],
    dependencies={"session": provide_async_session, "transaction": provide_async_transaction},
    lifespan=[my_lifespan, db_connection],
    debug=True,
    logging_config=None,
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
