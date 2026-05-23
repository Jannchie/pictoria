"""Domain exceptions raised by the server layer.

These types decouple business-meaning ("post not found") from transport
("404 response with JSON body"). Litestar exception_handlers (registered
in ``app.py``) translate each domain exception to a consistent HTTP
response shape, so controllers no longer hand-craft ``HTTPException``
calls inline for the same conditions.
"""

from __future__ import annotations


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
