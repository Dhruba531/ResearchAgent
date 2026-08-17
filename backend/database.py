from __future__ import annotations

"""Database and filesystem locations for the local AgentLab MVP.

The app defaults to SQLite and local artifact storage so a fresh checkout can
run without external services. Environment variables keep the same code path
usable for tests and future PostgreSQL/object-storage style deployments.
"""

import os
from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parent
APP_DIR = BACKEND_DIR.parent

# These paths are intentionally centralized so API code, the real runner, tests,
# and seed data all agree on where durable local state lives.
DATA_DIR = Path(os.environ.get("AGENTLAB_DATA_DIR", APP_DIR / "data"))
ARTIFACT_ROOT = Path(os.environ.get("AGENTLAB_ARTIFACT_ROOT", DATA_DIR / "artifacts"))
DATABASE_URL = os.environ.get("AGENTLAB_DATABASE_URL", f"sqlite:///{DATA_DIR / 'agentlab.sqlite3'}")

DATA_DIR.mkdir(parents=True, exist_ok=True)
ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)


class Base(DeclarativeBase):
    pass


engine_kwargs = {}
if DATABASE_URL.startswith("sqlite"):
    # The runner touches the DB from worker threads while the request that started
    # it has already returned, so SQLite's same-thread assertion has to be relaxed.
    engine_kwargs["connect_args"] = {"check_same_thread": False}
    if DATABASE_URL == "sqlite:///:memory:":
        # StaticPool keeps the in-memory database shared across TestClient sessions.
        engine_kwargs["poolclass"] = StaticPool
else:
    # Production databases (e.g. Postgres): verify pooled connections and size the pool
    # so the async runner + WebSocket workers don't exhaust or use dead connections.
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_size"] = int(os.environ.get("AGENTLAB_DB_POOL_SIZE", "5"))
    engine_kwargs["max_overflow"] = int(os.environ.get("AGENTLAB_DB_MAX_OVERFLOW", "10"))

engine = create_engine(DATABASE_URL, **engine_kwargs)
# expire_on_commit=False: routes and the runner keep reading model attributes after
# a commit (to serialize a response or broadcast a log line), and the default would
# turn each of those reads into a fresh SELECT — or an error once the session closes.
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def init_db() -> None:
    """Create tables for the local MVP if they do not already exist."""
    import models  # noqa: F401

    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that scopes a SQLAlchemy session to one request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
