import os
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from ai.clip import calculate_image_features
from models import Post, PostVector
from utils import get_session

load_dotenv()


def insert_img_vec(post_id: int, image_path: Path):
    features = calculate_image_features(image_path)
    features_np = features.cpu().numpy()
    with get_session() as session:
        session.add(PostVector(post_id=post_id, embedding=features_np[0]))
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


def find_similar_posts(vec: np.ndarray, *, limit: int = 100) -> list[SimilarImageResult]:
    with get_session() as session:
        distance = PostVector.embedding.cosine_distance(vec)
        query = select(PostVector.post_id, distance.label("distance")).order_by(distance).limit(limit).offset(1)
        result = session.execute(query).all()
    return [SimilarImageResult(post_id=row[0], distance=row[1]) for row in result]


db_url = os.environ.get("DB_URL")
aengine = create_async_engine(db_url, echo=False, pool_size=100, max_overflow=200)
ASession = async_sessionmaker(bind=aengine, expire_on_commit=False)
