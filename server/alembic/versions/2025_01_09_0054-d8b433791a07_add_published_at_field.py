"""add published at field

Revision ID: d8b433791a07
Revises: 982ba76522d1
Create Date: 2025-01-09 00:54:32.981414

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'd8b433791a07'
down_revision: Union[str, None] = '982ba76522d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('posts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('published_at', postgresql.TIMESTAMP(), nullable=True))
        batch_op.create_index(batch_op.f('ix_posts_published_at'), ['published_at'], unique=False)

    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('posts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_posts_published_at'))
        batch_op.drop_column('published_at')

    # ### end Alembic commands ###
