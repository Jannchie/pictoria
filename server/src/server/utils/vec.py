import asyncio
from pathlib import Path

import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ai.clip import calculate_image_features
from db import SimilarImageResult
from models import Post, PostVector


async def find_similar_posts(session: AsyncSession, vec: np.ndarray, *, limit: int = 100) -> list[SimilarImageResult]:
    distance = PostVector.embedding.cosine_distance(vec)
    stmt = select(PostVector.post_id, distance.label("distance")).order_by(distance).limit(limit).offset(1)
    result = (await session.execute(stmt)).all()
    return [SimilarImageResult(post_id=row[0], distance=row[1]) for row in result]


async def insert_img_vec(session: AsyncSession, post_id: int, image_path: Path):
    features = await asyncio.to_thread(calculate_image_features, image_path)
    features_np = features.cpu().numpy()
    session.add(PostVector(post_id=post_id, embedding=features_np[0]))
    await session.flush()
    return features_np


async def get_img_vec(session: AsyncSession, post: Post):
    post_id = post.id
    return await session.scalar(
        select(PostVector).where(PostVector.post_id == post_id),
    )


async def get_img_vec_by_id(session: AsyncSession, post_id: int):
    post_vector = await session.scalar(
        select(PostVector).where(PostVector.post_id == post_id),
    )
    return None if post_vector is None else post_vector.embedding
