import os
import pathlib
import re
import tomllib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from litestar import Litestar, Router
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
from server.images import ImageController
from server.posts import PostController
from server.tags import TagsController
from utils import initialize, logger

console = get_console()


with pathlib.Path("pyproject.toml").open("rb") as f:
    pyproject = tomllib.load(f)


@asynccontextmanager
async def my_lifespan(_: Litestar):
    load_dotenv()
    initialize(target_dir="demo")
    # sync_metadata()
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
    route_handlers=[PostController, CommandController, ImageController, TagsController],
)

SEPARATORS_CLEANUP_PATTERN = re.compile(r"[!#$%&'*+\-.^_`|~:]+")


def split_identifier_into_words(identifier: str) -> list[str]:
    """Splits snake_case and camelCase identifiers into words."""
    if not identifier:
        return []

    # Handle path parameters like {user_id} -> user id
    if identifier.startswith("{") and identifier.endswith("}"):
        identifier = identifier[1:-1]

    # Replace underscores with spaces
    s = identifier.replace("_", " ")

    # Insert space before uppercase letters preceded by lowercase,
    # or before sequences of uppercase letters followed by lowercase (e.g., HTTPRequest -> HTTP Request)
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)

    return [word.lower() for word in s.split() if word]


def default_operation_id_creator_with_spaces(
    route_handler: HTTPRouteHandler,
    http_method: Method,
    path_components: list[str | PathParameterDefinition],
) -> str:
    """
    Create a unique 'operationId' for an OpenAPI PathItem entry,
    formatted as a title with words separated by spaces.

    Args:
        route_handler: The HTTP Route Handler instance.
        http_method: The HTTP method for the given PathItem (e.g., 'GET').
        path_components: A list of path components (strings or PathParameterDefinition).

    Returns:
        A space-separated, Title Cased operationId created from the
        path components, handler function name, and potentially the http method.
    """
    all_words: list[str] = []

    # Add HTTP method first if handler supports multiple methods (for uniqueness)
    # Use lower case for consistency before final titling
    if len(route_handler.http_methods) > 1:
        all_words.append(http_method.lower())

    # Process path components
    for component in path_components:
        # Convert component to string - handle PathParameterDefinition
        comp_str = str(component)
        # Skip empty strings or root path "/" representation if any
        if comp_str and comp_str != "/":
            all_words.extend(split_identifier_into_words(comp_str))

    # Process handler name
    all_words.extend(split_identifier_into_words(route_handler.handler_name))

    # Remove potential duplicates while preserving order (simple approach)
    unique_ordered_words = []
    seen = set()
    for word in all_words:
        if word not in seen:
            unique_ordered_words.append(word)
            seen.add(word)

    # Join words with spaces
    result = " ".join(unique_ordered_words)

    # Convert the final string to Title Case
    # Example: "get users list" -> "Get Users List"
    return result.title()


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
        operation_id_creator=default_operation_id_creator_with_spaces,
        use_handler_docstrings=True,
    ),
    plugins=[PydanticPlugin(prefer_alias=True)],
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", port=4777, reload=True, reload_dirs=["src"], reload_excludes=[".venv"], log_config=None)
