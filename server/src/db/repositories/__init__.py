from db.repositories.colors import ColorRepo
from db.repositories.failures import FailureRepo
from db.repositories.posts import PostRepo
from db.repositories.scores import ScoreRepo
from db.repositories.tags import TagGroupRepo, TagRepo
from db.repositories.vectors import VectorRepo

__all__ = [
    "ColorRepo",
    "FailureRepo",
    "PostRepo",
    "ScoreRepo",
    "TagGroupRepo",
    "TagRepo",
    "VectorRepo",
]
