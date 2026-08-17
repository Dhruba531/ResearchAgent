from __future__ import annotations

"""Optional pgvector-backed semantic store for RAG-grounded research runs.

Enabled only when ``AGENTLAB_VECTOR_DATABASE_URL`` points at a Postgres database
with the ``vector`` extension available, e.g.::

    AGENTLAB_VECTOR_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/agentlab

When unset (or if the database/extension/SDK is unavailable) every function is a
safe no-op, so the default SQLite MVP keeps running with zero extra services.

Embeddings are OpenAI ``text-embedding-3-small`` (1536 dims). One row is stored
per text chunk, scoped to a user/project/run, so retrieval can ground the
draft/verify stages and provide cross-run memory.

Heavy imports (SQLAlchemy bindings, pgvector) are deferred into ``_build`` so the
module is importable even when pgvector/psycopg aren't installed.
"""

import os
import logging
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Tuple

# Reuse the main database for vectors when it is Postgres and no dedicated vector
# URL is set — so "one Postgres for everything" needs only AGENTLAB_DATABASE_URL.
_main_db = os.environ.get("AGENTLAB_DATABASE_URL", "").strip()
VECTOR_DATABASE_URL = (
    os.environ.get("AGENTLAB_VECTOR_DATABASE_URL", "").strip()
    or (_main_db if _main_db.startswith(("postgresql", "postgres")) else "")
)
EMBED_DIM = 1536  # OpenAI text-embedding-3-small

_engine = None
_SessionLocal = None
_Document = None
_ready = False
_init_error: Optional[str] = None
_build_lock = threading.Lock()
_log = logging.getLogger("agentlab.vector_store")


def is_enabled() -> bool:
    """True if a vector database URL is configured (does not yet connect)."""
    return bool(VECTOR_DATABASE_URL)


def init_error() -> Optional[str]:
    return _init_error


def _build() -> None:
    """Lazily connect, create the extension/table/index. Idempotent + safe.

    May be called from worker threads (asyncio.to_thread), so the actual build is
    serialized under a lock to avoid concurrent first-time initialization.
    """
    # Fast path outside the lock: after the first build every call is a hot no-op,
    # and a failed build is remembered in _init_error so a dead vector database is
    # not retried (and reconnected to) on every single retrieval.
    if _ready or _init_error is not None:
        return
    with _build_lock:
        _build_locked()


def _build_locked() -> None:
    global _engine, _SessionLocal, _Document, _ready, _init_error
    if _ready or _init_error is not None:  # re-check under the lock
        return
    if not VECTOR_DATABASE_URL:
        _init_error = "AGENTLAB_VECTOR_DATABASE_URL not set"
        return
    try:
        from sqlalchemy import DateTime, Integer, String, Text, create_engine, text
        from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
        from pgvector.sqlalchemy import Vector

        class Base(DeclarativeBase):
            pass

        class Document(Base):
            __tablename__ = "rag_documents"

            id: Mapped[int] = mapped_column(Integer, primary_key=True)
            user_id: Mapped[int] = mapped_column(Integer, index=True)
            project_id: Mapped[Optional[int]] = mapped_column(Integer, index=True, nullable=True)
            run_id: Mapped[Optional[int]] = mapped_column(Integer, index=True, nullable=True)
            kind: Mapped[str] = mapped_column(String(40), default="")
            source_url: Mapped[str] = mapped_column(String(1024), default="")
            content: Mapped[str] = mapped_column(Text)
            embedding = mapped_column(Vector(EMBED_DIM))
            created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

        engine = create_engine(VECTOR_DATABASE_URL, pool_pre_ping=True)
        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        Base.metadata.create_all(bind=engine)
        # Approximate-NN index for fast cosine search (pgvector >= 0.5). Optional:
        # ordering by cosine distance works without it, just slower at scale.
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx "
                    "ON rag_documents USING hnsw (embedding vector_cosine_ops)"
                ))
        except Exception as exc:
            _log.warning("Optional pgvector HNSW index was not created: %s", type(exc).__name__)

        _engine = engine
        _SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        _Document = Document
        _ready = True
    except Exception as exc:  # missing SDK, bad URL, unreachable DB, no extension…
        _init_error = f"{type(exc).__name__}: {exc}"


def ready() -> bool:
    """Attempt to connect and return whether the store is usable."""
    _build()
    return _ready


def add_documents(items: Sequence[Dict]) -> int:
    """Insert chunk rows. Each item: user_id, [project_id], [run_id], kind,
    [source_url], content, embedding (list[float]). Returns rows written."""
    if not ready():
        return 0
    written = 0
    # Skip anything without both halves: a row with a NULL embedding would be
    # invisible to cosine search forever, i.e. silently lost rather than retrievable.
    rows = [it for it in items if it.get("content") and it.get("embedding") is not None]
    if not rows:
        return 0
    stamp = datetime.now(timezone.utc)
    with _SessionLocal() as db:
        for it in rows:
            db.add(_Document(
                user_id=int(it["user_id"]),
                project_id=it.get("project_id"),
                run_id=it.get("run_id"),
                kind=str(it.get("kind", ""))[:40],
                source_url=str(it.get("source_url", ""))[:1024],
                content=str(it["content"]),
                embedding=list(it["embedding"]),
                created_at=stamp,
            ))
            written += 1
        db.commit()
    return written


def search(
    embedding: Sequence[float],
    k: int = 6,
    user_id: Optional[int] = None,
    project_id: Optional[int] = None,
    exclude_run_id: Optional[int] = None,
) -> List[Tuple[str, str, float]]:
    """Return up to ``k`` nearest chunks as (content, source_url, cosine_distance)."""
    if not ready():
        return []
    query_vec = list(embedding)
    with _SessionLocal() as db:
        dist = _Document.embedding.cosine_distance(query_vec).label("dist")
        q = db.query(_Document.content, _Document.source_url, dist)
        if user_id is not None:
            q = q.filter(_Document.user_id == user_id)
        if project_id is not None:
            q = q.filter(_Document.project_id == project_id)
        if exclude_run_id is not None:
            # Cross-run memory: a run must not retrieve its own chunks, or it would
            # cite itself as prior work. The IS NULL arm keeps project-level
            # documents (not tied to any run) in scope.
            q = q.filter((_Document.run_id != exclude_run_id) | (_Document.run_id.is_(None)))
        # ORDER BY distance is what lets pgvector use the HNSW index built above;
        # filtering on distance in Python instead would force a full scan.
        rows = q.order_by(dist).limit(k).all()
    return [(r.content, r.source_url, float(r.dist)) for r in rows]


def chunk_text(value: str, size: int = 1500) -> List[str]:
    """Split text into ~``size``-char chunks for embedding/storage."""
    value = (value or "").strip()
    if not value:
        return []
    return [value[i:i + size] for i in range(0, len(value), size)]
