from __future__ import annotations

"""Supabase JWT verification for the FastAPI agent service.

Production architecture: **Supabase app + FastAPI agent**. The frontend
authenticates with Supabase and calls this service with the Supabase access
token as ``Authorization: Bearer <jwt>``. Legacy HS256 tokens use the project
secret; current RS256/ES256 tokens use Supabase's rotating JWKS endpoint.

Graceful: disabled when neither legacy secret nor JWKS issuer is configured —
the existing cookie session auth keeps working for local development.
"""

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import User

SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "").strip()
# Supabase access tokens carry aud="authenticated". Tokens minted for anything
# else (e.g. the anon role, or another app sharing the secret) are rejected.
# Set SUPABASE_JWT_AUD="" to disable the audience check explicitly.
SUPABASE_JWT_AUD = os.environ.get("SUPABASE_JWT_AUD", "authenticated").strip()
SUPABASE_JWT_ISS = os.environ.get("SUPABASE_JWT_ISS", "").strip()
SUPABASE_JWKS_URL = os.environ.get("SUPABASE_JWKS_URL", "").strip() or (
    f"{SUPABASE_JWT_ISS.rstrip('/')}/.well-known/jwks.json" if SUPABASE_JWT_ISS else ""
)
_MAX_JWT_CHARS = 16_384
_jwk_client = None


def is_enabled() -> bool:
    return bool(SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)


def _get_jwk_client():
    global _jwk_client
    if _jwk_client is None:
        from jwt import PyJWKClient

        # Supabase edge caches JWKS for ten minutes. Match that window while
        # still refreshing automatically for rotation and revocation.
        _jwk_client = PyJWKClient(SUPABASE_JWKS_URL, cache_keys=True, lifespan=600)
    return _jwk_client


def _b64url(data: str) -> bytes:
    # JWT segments are base64url with the padding stripped, which Python's decoder
    # rejects — re-add it to the next multiple of four.
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_jwt(
    token: str,
    secret: str,
    audience: Optional[str] = None,
    issuer: Optional[str] = None,
) -> dict:
    """Verify a Supabase HS256 JWT and return its claims. Raises ValueError on any failure.

    Beyond the signature, the token must carry: a required ``exp`` (a token that
    can never expire is rejected), a matching ``aud`` (unless the check is
    disabled), and a non-empty ``sub`` (the Supabase user id).
    """
    if audience is None:
        audience = SUPABASE_JWT_AUD
    if issuer is None:
        issuer = SUPABASE_JWT_ISS
    if not token or len(token) > _MAX_JWT_CHARS:
        raise ValueError("invalid token size")
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError:
        raise ValueError("malformed token")
    header = json.loads(_b64url(header_b64))
    if not isinstance(header, dict):
        raise ValueError("malformed header")
    # The algorithm is pinned to the one this function actually implements, so a
    # token claiming alg="none" (or an asymmetric alg, hoping the public key gets
    # used as an HMAC secret) is rejected outright instead of dispatched on.
    if header.get("alg") != "HS256":
        raise ValueError(f"unsupported alg: {header.get('alg')!r}")
    # The signature covers the raw encoded segments, so they are re-joined verbatim
    # rather than re-serialized from the parsed dicts.
    signing_input = f"{header_b64}.{payload_b64}".encode()
    expected = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _b64url(sig_b64)):
        raise ValueError("bad signature")
    # Claims are only parsed after the signature checks out — nothing in an
    # unverified payload gets a chance to influence the checks below.
    claims = json.loads(_b64url(payload_b64))
    if not isinstance(claims, dict):
        raise ValueError("malformed claims")
    exp = claims.get("exp")
    if exp is None:
        raise ValueError("missing exp")
    if float(exp) < time.time():
        raise ValueError("expired")
    nbf = claims.get("nbf")
    if nbf is not None and float(nbf) > time.time() + 30:
        # 30s of leeway for clock skew between Supabase and this host; without it a
        # freshly minted token can be rejected as "not yet valid". Applied to nbf
        # only — exp is checked strictly, so skew never extends a token's life.
        raise ValueError("not yet valid")
    if audience:
        aud = claims.get("aud")
        auds = aud if isinstance(aud, list) else [aud]
        if audience not in auds:
            raise ValueError(f"bad audience: {aud!r}")
    if issuer and claims.get("iss") != issuer:
        raise ValueError("bad issuer")
    if not str(claims.get("sub") or "").strip():
        raise ValueError("missing sub")
    return claims


def verify_access_token(token: str) -> dict:
    """Verify a legacy HS256 or rotating RS256/ES256 Supabase access token."""
    if not token or len(token) > _MAX_JWT_CHARS:
        raise ValueError("invalid token size")
    try:
        header_b64 = token.split(".", 1)[0]
        header = json.loads(_b64url(header_b64))
    except Exception as exc:
        raise ValueError("malformed token header") from exc
    if not isinstance(header, dict):
        raise ValueError("malformed token header")
    # The header is read before verification purely to route to the right verifier;
    # both branches then pin `algorithms` to that single value, so the untrusted
    # header can pick a path but never weaken the check on it.
    algorithm = str(header.get("alg") or "")
    if algorithm == "HS256":
        if not SUPABASE_JWT_SECRET:
            raise ValueError("legacy HS256 verification is not configured")
        return verify_jwt(token, SUPABASE_JWT_SECRET)
    if algorithm not in {"RS256", "ES256"}:
        raise ValueError(f"unsupported alg: {algorithm!r}")
    if not SUPABASE_JWKS_URL or not SUPABASE_JWT_ISS:
        raise ValueError("JWKS verification is not configured")

    import jwt

    signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
    options = {
        "require": ["exp", "sub"],
        "verify_aud": bool(SUPABASE_JWT_AUD),
        "verify_iss": bool(SUPABASE_JWT_ISS),
    }
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=[algorithm],
        audience=SUPABASE_JWT_AUD or None,
        issuer=SUPABASE_JWT_ISS or None,
        options=options,
        leeway=30,
    )
    if not str(claims.get("sub") or "").strip():
        raise ValueError("missing sub")
    return claims


def claims_from_header(authorization: Optional[str]) -> Optional[dict]:
    """Verify a Bearer token from an Authorization header; None if absent/invalid/disabled."""
    if not is_enabled() or not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    try:
        return verify_access_token(parts[1].strip())
    except Exception:
        return None


def user_from_claims(db: Session, claims: dict) -> Optional[User]:
    """Map verified Supabase claims to a local User, provisioning one on first sight."""
    subject = str(claims.get("sub") or "").strip()
    email = (claims.get("email") or "").strip().lower()
    if not subject or len(subject) > 255 or not email:
        return None
    # Externally-authenticated users have no local password, so the password_hash
    # column carries a marker derived from the Supabase subject id instead. That
    # doubles as the identity binding checked at the bottom of this function, and
    # its shape can never collide with a real PBKDF2 hash ("pbkdf2_sha256$…"), so
    # the marker cannot be replayed as a password. The subject is hashed rather
    # than stored raw to keep the upstream id out of the users table.
    subject_marker = "external:supabase:" + hashlib.sha256(subject.encode()).hexdigest()
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        meta = claims.get("user_metadata") or {}
        user = User(
            name=str(meta.get("name") or email.split("@")[0])[:120],
            email=email,
            password_hash=subject_marker,
            role="researcher",
        )
        db.add(user)
        try:
            db.commit()
            db.refresh(user)
            return user
        except IntegrityError:
            # Another request may have provisioned the same identity between
            # our lookup and insert. Re-read and verify the subject binding.
            db.rollback()
            user = db.query(User).filter(User.email == email).first()
            if user is None:
                return None
    if not user.password_hash:  # legacy external identities used an empty marker
        # Securely bind legacy externally-created rows on their next valid login.
        user.password_hash = subject_marker
        db.commit()
        db.refresh(user)
        return user
    if not hmac.compare_digest(user.password_hash, subject_marker):
        # Never merge an external identity into a local-password account merely
        # because the email claim happens to match.
        return None
    return user
