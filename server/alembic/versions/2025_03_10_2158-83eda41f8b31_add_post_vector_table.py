"""add post vector table

Revision ID: 83eda41f8b31
Revises: d8b433791a07
Create Date: 2025-03-10 21:58:13.150581

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '83eda41f8b31'
down_revision: Union[str, None] = 'd8b433791a07'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
