import sqlite3
from pathlib import Path

import numpy as np
from pydantic import BaseModel
from sqlalchemy import select

from ai.clip import calculate_image_features
from models import Post, PostVector
from utils import get_session


def insert_img_vec(post_id: int, image_path: Path):
    features = calculate_image_features(image_path)
    features_np = features.cpu().numpy()
    with get_session() as session:
        session.add(PostVector(post_id=post_id, embedding=features_np))
        session.commit()
    return features_np


def get_img_vec(post: Post):
    post_id = post.id
    with get_session() as session:
        post_vector = session.scalar(
            select(PostVector).where(PostVector.post_id == post_id),
        )
    if post_vector is None:
        return insert_img_vec(post_id, post.absolute_path)
    return post_vector.embedding


class SimilarImageResult(BaseModel):
    post_id: int
    distance: float


def find_similar_posts(vec: np.ndarray, *, limit: int = 1000) -> list[SimilarImageResult]:
    with get_session() as session:
        query = select(PostVector).where(PostVector.embedding.match(vec, k=limit + 1)).offset(1)
        result = session.scalars(query)
    return [SimilarImageResult(post_id=row[0], distance=row[1]) for row in result]
