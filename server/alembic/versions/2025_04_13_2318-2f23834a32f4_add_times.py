"""add times

Revision ID: 2f23834a32f4
Revises: 0459296feb3a
Create Date: 2025-04-13 23:18:31.927972

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '2f23834a32f4'
down_revision: Union[str, None] = '0459296feb3a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('tag_groups', schema=None) as batch_op:
        batch_op.add_column(sa.Column('created_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), nullable=False))
        batch_op.add_column(sa.Column('updated_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), nullable=False))
        batch_op.create_index(batch_op.f('ix_tag_groups_created_at'), ['created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_tag_groups_updated_at'), ['updated_at'], unique=False)

    with op.batch_alter_table('tags', schema=None) as batch_op:
        batch_op.add_column(sa.Column('created_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), nullable=False))
        batch_op.add_column(sa.Column('updated_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), nullable=False))
        batch_op.create_index(batch_op.f('ix_tags_created_at'), ['created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_tags_updated_at'), ['updated_at'], unique=False)

    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    with op.batch_alter_table('tags', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_tags_updated_at'))
        batch_op.drop_index(batch_op.f('ix_tags_created_at'))
        batch_op.drop_column('updated_at')
        batch_op.drop_column('created_at')

    with op.batch_alter_table('tag_groups', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_tag_groups_updated_at'))
        batch_op.drop_index(batch_op.f('ix_tag_groups_created_at'))
        batch_op.drop_column('updated_at')
        batch_op.drop_column('created_at')

    # ### end Alembic commands ###
