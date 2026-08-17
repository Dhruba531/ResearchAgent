from __future__ import annotations

"""Symmetric encryption for secrets at rest (provider API keys).

Uses Fernet (AES-128-CBC + HMAC-SHA256) keyed by ``AGENTLAB_SECRET_KEY`` — a
urlsafe-base64 32-byte key. Generate one with::

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Behavior (so dev stays zero-config and prod is secure):
- ``AGENTLAB_SECRET_KEY`` set + ``cryptography`` installed → values are encrypted
  at rest and stored with an ``enc:v1:`` prefix.
- Key unset (dev) → values are stored as-is, with a one-time warning.
- ``decrypt`` passes through any value lacking the prefix, so a database written
  in dev (plaintext) still works after enabling the key, and vice-versa.
"""

import logging
import os
from typing import Optional

_PREFIX = "enc:v1:"
_log = logging.getLogger("agentlab.crypto")


class SecretConfigurationError(RuntimeError):
    """Raised when secret encryption is required but unavailable."""

_fernet = None
_resolved = False


def _cipher():
    # Resolved once per process and cached, including the failure case: the missing-key
    # warning below must be logged once at first use, not on every key read.
    global _fernet, _resolved
    if _resolved:
        return _fernet
    _resolved = True
    key = os.environ.get("AGENTLAB_SECRET_KEY", "").strip()
    if not key:
        _log.warning(
            "AGENTLAB_SECRET_KEY is not set — provider API keys are stored UNENCRYPTED. "
            "Set it in production."
        )
        return None
    try:
        from cryptography.fernet import Fernet

        _fernet = Fernet(key.encode())
    except Exception as exc:  # missing lib or malformed key
        _log.error("Secret encryption disabled (%s) — provider keys stored UNENCRYPTED.", exc)
        _fernet = None
    return _fernet


def is_active() -> bool:
    return _cipher() is not None


def encryption_required() -> bool:
    """Whether plaintext provider keys are forbidden in this environment.

    Inferred from ``AGENTLAB_ENV`` so a real deployment is strict by default and
    cannot be left permissive by forgetting a second flag; the explicit override is
    checked first for the cases the environment name does not capture.
    """
    explicit = os.environ.get("AGENTLAB_REQUIRE_SECRET_ENCRYPTION", "").strip().lower()
    if explicit:
        return explicit in {"1", "true", "yes"}
    return os.environ.get("AGENTLAB_ENV", "").strip().lower() in {"production", "staging"}


def validate_configuration() -> None:
    """Fail startup instead of silently storing provider credentials in plaintext."""
    if encryption_required() and _cipher() is None:
        raise SecretConfigurationError(
            "AGENTLAB_SECRET_KEY must be a valid Fernet key when secret encryption is required."
        )


def is_encrypted(value: Optional[str]) -> bool:
    return bool(value) and value.startswith(_PREFIX)


def encrypt(value: str) -> str:
    """Encrypt a secret for storage. No-op if encryption is unavailable or the
    value is already encrypted."""
    # The prefix check makes this idempotent: re-saving an already-encrypted value
    # must not wrap it a second time, or decrypt would return ciphertext.
    if not value or value.startswith(_PREFIX):
        return value
    cipher = _cipher()
    if cipher is None:
        if encryption_required():
            raise SecretConfigurationError("Provider-key encryption is required but unavailable.")
        return value
    return _PREFIX + cipher.encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    """Decrypt a stored secret. Plaintext (no prefix) passes through unchanged."""
    if not value:
        return value
    if not value.startswith(_PREFIX):
        if encryption_required():
            raise SecretConfigurationError("Plaintext provider key is not permitted in this environment.")
        return value
    cipher = _cipher()
    if cipher is None:
        raise SecretConfigurationError("Encrypted provider key cannot be decrypted without AGENTLAB_SECRET_KEY.")
    try:
        return cipher.decrypt(value[len(_PREFIX):].encode()).decode()
    except Exception as exc:
        # Most likely a rotated AGENTLAB_SECRET_KEY. Surfaced as a configuration
        # error (not a bad key) so the operator is told to restore the old key or
        # have users re-enter theirs, and the underlying error is not echoed to a
        # client response.
        raise SecretConfigurationError("Encrypted provider key could not be decrypted.") from exc
