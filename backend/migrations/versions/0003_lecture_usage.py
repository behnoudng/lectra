"""Remember whether a lecture has been used elsewhere."""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.get_bind().exec_driver_sql(
        "ALTER TABLE lectures ADD COLUMN is_used INTEGER NOT NULL DEFAULT 0 CHECK(is_used IN (0,1))"
    )


def downgrade():
    raise RuntimeError(
        "Downgrade would discard lecture usage marks. Restore a backup instead."
    )
