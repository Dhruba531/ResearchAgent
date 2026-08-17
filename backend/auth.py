from __future__ import annotations

"""Authentication helpers for the local full-stack MVP.

This module avoids external auth services while still using the core production
shape: hashed passwords, HTTP-only session cookies, server-side session rows,
and a `current_user` dependency for protected APIs.
"""

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from database import get_db
from models import AuthSession, User

import supabase_auth


SESSION_COOKIE = "agentlab_session"
SESSION_DAYS = 7
PBKDF2_ROUNDS = 260_000
MAX_ACTIVE_SESSIONS = max(1, int(os.environ.get("AGENTLAB_MAX_ACTIVE_SESSIONS", "10")))

# Cookie security posture, tunable per deployment:
#   AGENTLAB_COOKIE_SECURE=1     -> Secure flag (required behind HTTPS/tunnel)
#   AGENTLAB_COOKIE_SAMESITE     -> lax (default) | strict | none
#
# CSRF note for cross-origin deployments: SameSite=Lax is the browser-level CSRF
# defense for this cookie. When SameSite=None is required (cross-site frontend),
# the cookie is attached cross-site, so the Origin-allowlist guard in app.py
# (`csrf_origin_guard` for unsafe HTTP methods + the Origin check on the log
# WebSocket handshake) becomes the defense instead — it rejects credentialed
# requests from any origin not in AGENTLAB_CORS_ORIGINS. That guard only engages
# when an allowlist is configured. SameSite=None also requires Secure.
COOKIE_SECURE = os.environ.get("AGENTLAB_COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}
COOKIE_SAMESITE = os.environ.get("AGENTLAB_COOKIE_SAMESITE", "lax").strip().lower() or "lax"
if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    COOKIE_SAMESITE = "lax"
if COOKIE_SAMESITE == "none":  # browsers reject SameSite=None without Secure
    COOKIE_SECURE = True


def hash_token(token: str) -> str:
    # Only the hash is stored, so a leaked session table yields no usable cookies.
    # A plain SHA-256 is enough here (unlike passwords): the token is 32 bytes of
    # CSPRNG output, so there is nothing to brute-force and no salt to add.
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    """Hash a password with stdlib PBKDF2 so the app has no native dependency."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    """Constant-time password verification for stored PBKDF2 hashes."""
    try:
        algorithm, rounds, salt_hex, digest_hex = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        parsed_rounds = int(rounds)
        # The round count is read back out of the row so old hashes keep verifying
        # after PBKDF2_ROUNDS is raised. Bound it in both directions: too low would
        # honour a downgraded hash, too high would let a tampered row pin a CPU for
        # the duration of a login attempt.
        if parsed_rounds < 100_000 or parsed_rounds > 1_000_000:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            parsed_rounds,
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def create_auth_session(db: Session, user: User, response: Response) -> None:
    """Create a durable session row and set the opaque browser cookie."""
    # Bound durable session growth and reduce the number of useful stolen tokens.
    sessions = (
        db.query(AuthSession)
        .filter(AuthSession.user_id == user.id)
        .order_by(AuthSession.created_at.desc())
        .all()
    )
    # Newest-first ordering above means the slice is the oldest sessions; the -1
    # leaves room for the one being created, so the cap counts this login too.
    for stale in sessions[MAX_ACTIVE_SESSIONS - 1 :]:
        db.delete(stale)
    token = secrets.token_urlsafe(32)
    session = AuthSession(
        user_id=user.id,
        token_hash=hash_token(token),
        expires_at=datetime.utcnow() + timedelta(days=SESSION_DAYS),
    )
    db.add(session)
    db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        max_age=SESSION_DAYS * 24 * 60 * 60,
    )


def clear_auth_session(db: Session, token: Optional[str], response: Response) -> None:
    """Delete the server-side session and clear the browser cookie."""
    if token:
        session = db.query(AuthSession).filter(AuthSession.token_hash == hash_token(token)).first()
        if session:
            db.delete(session)
            db.commit()
    response.delete_cookie(SESSION_COOKIE)


def user_from_token(db: Session, token: Optional[str]) -> Optional[User]:
    """Resolve a session cookie token into a user, expiring stale sessions."""
    if not token:
        return None
    session = db.query(AuthSession).filter(AuthSession.token_hash == hash_token(token)).first()
    if not session or session.expires_at < datetime.utcnow():
        if session:
            # Reap on read: there is no session-expiry sweeper, so the request that
            # presents a dead cookie is what removes the row.
            db.delete(session)
            db.commit()
        return None
    return db.get(User, session.user_id)


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """FastAPI dependency used by every authenticated route.

    Accepts a **Supabase JWT** (``Authorization: Bearer``) when
    ``SUPABASE_JWT_SECRET`` is configured — the production "Supabase app + FastAPI
    agent" path — and otherwise falls back to the local **session cookie**, so the
    Supabase-fronted app and the local cookie flow coexist during migration.
    """
    authorization = request.headers.get("authorization")
    claims = supabase_auth.claims_from_header(authorization)
    if claims is not None:
        user = supabase_auth.user_from_claims(db, claims)
        if user is not None:
            return user
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="External identity is not authorized.")
    if authorization and supabase_auth.is_enabled():
        # Do not silently downgrade a bad bearer token to ambient cookie auth.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token.")
    user = user_from_token(db, request.cookies.get(SESSION_COOKIE))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    return user
