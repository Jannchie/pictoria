from pydantic import BaseModel

from db.connection import DB
from db.migrator import run_migrations


class SimilarImageResult(BaseModel):
    post_id: int
    distance: float


__all__ = ["DB", "SimilarImageResult", "run_migrations"]
