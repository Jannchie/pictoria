"""add vector indexes for embedding and dominant_color

Revision ID: c1a7f3d9b5e2
Revises: 5b60f1ec6a4b
Create Date: 2026-05-12 00:01:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = "c1a7f3d9b5e2"
down_revision: Union[str, None] = "5b60f1ec6a4b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_post_vectors_embedding_hnsw "
        "ON post_vectors USING hnsw (embedding halfvec_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_posts_dominant_color_hnsw "
        "ON posts USING hnsw (dominant_color vector_l2_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_posts_dominant_color_hnsw")
    op.execute("DROP INDEX IF EXISTS ix_post_vectors_embedding_hnsw")
