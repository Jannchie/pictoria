"""rename waifu score

Revision ID: 6dbeb14619fb
Revises: 375b24b8c1db
Create Date: 2025-06-01 13:52:33.886128

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6dbeb14619fb'
down_revision: Union[str, None] = '375b24b8c1db'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # rename table 'post_waifu_scorer' to 'post_waifu_scores'
    op.rename_table('post_waifu_scorer', 'post_waifu_scores')


def downgrade() -> None:
    # rename table 'post_waifu_scores' back to 'post_waifu_scorer'
    op.rename_table('post_waifu_scores', 'post_waifu_scorer')
