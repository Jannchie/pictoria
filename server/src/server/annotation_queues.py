"""Annotation queue endpoints (filled in by the queue task)."""

from __future__ import annotations

from typing import ClassVar

from litestar import Controller


class AnnotationQueueController(Controller):
    path = "/annotation-queues"
    tags: ClassVar[list[str]] = ["Annotations"]
