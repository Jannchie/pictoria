"""server default updated_at

Revision ID: b36f463633c1
Revises: 2f23834a32f4
Create Date: 2025-04-19 17:44:49.762660

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b36f463633c1'
down_revision: Union[str, None] = '2f23834a32f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # set server_default for updated_at column for posts table
    with op.batch_alter_table('posts', schema=None) as batch_op:
        batch_op.alter_column('updated_at',
            existing_type=postgresql.TIMESTAMP(),
            type_=postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text('now()'),
            existing_nullable=False)

        batch_op.alter_column('created_at',
            existing_type=postgresql.TIMESTAMP(),
            type_=postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text('now()'),
            existing_nullable=False)

def downgrade() -> None:
    # remove server_default for updated_at column for posts table
    with op.batch_alter_table('posts', schema=None) as batch_op:
        batch_op.alter_column('updated_at',
            existing_type=postgresql.TIMESTAMP(),
            type_=postgresql.TIMESTAMP(timezone=True),
            server_default=None,
            existing_nullable=False)

        batch_op.alter_column('created_at',
            existing_type=postgresql.TIMESTAMP(),
            type_=postgresql.TIMESTAMP(timezone=True),
            server_default=None,
            existing_nullable=False)    
        