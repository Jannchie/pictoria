"""add thumbhash column to posts

Revision ID: 5b60f1ec6a4b
Revises: e8621e35996b
Create Date: 2025-11-23 01:09:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5b60f1ec6a4b'
down_revision: Union[str, None] = 'e8621e35996b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("posts", sa.Column("thumbhash", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("posts", "thumbhash")
