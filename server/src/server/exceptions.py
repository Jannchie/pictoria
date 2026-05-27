"""Domain exceptions raised by the server layer + their HTTP translation.

These types decouple business-meaning ("post not found") from transport
("404 response with JSON body"). ``domain_error_handler`` (registered in
``app.py`` as the handler for :class:`DomainError`) translates every domain
exception to one consistent response shape ``{"detail", "error"}``, so
controllers never hand-craft ``HTTPException`` / ``NotFoundException`` calls
inline for the same conditions.

The handler lives here (rather than in ``app.py``) so it can be imported
without pulling in ``app.py``'s heavy ML/processor imports — e.g. from tests.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from litestar.response import Response

if TYPE_CHECKING:
    from litestar.connection import Request


class DomainError(Exception):
    """Base class for server domain errors carrying a public message."""

    status_code: int = 400

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class PostNotFoundError(DomainError):
    status_code = 404

    def __init__(self, post_id: int) -> None:
        super().__init__(f"Post with id {post_id} not found.")
        self.post_id = post_id


class TagAlreadyExistsError(DomainError):
    status_code = 409

    def __init__(self, post_id: int, tag_name: str) -> None:
        super().__init__(f"Tag {tag_name} already exists in post {post_id}.")


class TagNotOnPostError(DomainError):
    status_code = 409

    def __init__(self, post_id: int, tag_name: str) -> None:
        super().__init__(f"Tag {tag_name} does not exist in post {post_id}.")


class InvalidArgumentError(DomainError):
    """Caller passed values outside the allowed range."""

    status_code = 409


class TagNameExistsError(DomainError):
    """A standalone tag with this name already exists (tag CRUD, not per-post)."""

    status_code = 409

    def __init__(self, tag_name: str) -> None:
        super().__init__(f"Tag '{tag_name}' already exists.")


class TagNameNotFoundError(DomainError):
    """No standalone tag with this name exists (tag CRUD, not per-post)."""

    status_code = 404

    def __init__(self, tag_name: str) -> None:
        super().__init__(f"Tag '{tag_name}' does not exist.")


class TagGroupNotFoundError(DomainError):
    status_code = 422

    def __init__(self, group_id: int) -> None:
        super().__init__(f"Tag group with ID {group_id} does not exist.")


class DirectoryNotFoundError(DomainError):
    status_code = 404

    def __init__(self, detail: str = "Directory not found.") -> None:
        super().__init__(detail)


class PathNotADirectoryError(DomainError):
    status_code = 400

    def __init__(self, detail: str = "Path is not a directory.") -> None:
        super().__init__(detail)


class MissingConfigError(DomainError):
    """A required runtime config value (e.g. an API key) is not set."""

    status_code = 400


class NotAnImageError(DomainError):
    status_code = 400

    def __init__(self, post_id: int) -> None:
        super().__init__(f"Post {post_id} is not an image.")


class InvalidUploadError(DomainError):
    status_code = 400

    def __init__(self, detail: str = "Either file or url must be provided.") -> None:
        super().__init__(detail)


class FileAlreadyExistsError(DomainError):
    status_code = 400

    def __init__(self, detail: str = "File already exists.") -> None:
        super().__init__(detail)


def domain_error_handler(_request: Request, exc: DomainError) -> Response:
    """Render any :class:`DomainError` as ``{"detail", "error"}`` with its status."""
    return Response(
        content={"detail": exc.detail, "error": type(exc).__name__},
        status_code=exc.status_code,
    )
