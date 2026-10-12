"""Keep bounded, redacted provider rejection diagnostics."""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    for name in ("error_code", "error_message", "request_id"):
        op.get_bind().exec_driver_sql(
            f"ALTER TABLE provider_attempts ADD COLUMN {name} TEXT"
        )


def downgrade():
    raise RuntimeError(
        "Downgrade would discard provider evidence. Restore a backup instead."
    )
