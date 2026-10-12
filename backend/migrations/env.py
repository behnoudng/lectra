from alembic import context
from sqlalchemy import create_engine
from app.config import settings

engine = create_engine(
    "sqlite:///" + str(context.config.attributes.get("db_path", settings().db_path))
)
try:
    with engine.connect() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        context.configure(connection=connection, target_metadata=None)
        with context.begin_transaction():
            context.run_migrations()
        connection.commit()
finally:
    engine.dispose()
