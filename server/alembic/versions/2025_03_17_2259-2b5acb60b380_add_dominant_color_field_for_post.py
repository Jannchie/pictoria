"""add dominant color field for post

Revision ID: 2b5acb60b380
Revises: 88b9106d8fa4
Create Date: 2025-03-17 22:59:48.325654

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import pgvector.sqlalchemy.vector

# revision identifiers, used by Alembic.
revision: str = '2b5acb60b380'
down_revision: Union[str, None] = '88b9106d8fa4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('posts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('dominant_color', pgvector.sqlalchemy.vector.VECTOR(dim=3), nullable=True))

    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('posts', schema=None) as batch_op:
        batch_op.drop_column('dominant_color')

    # ### end Alembic commands ###
