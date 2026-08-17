from __future__ import annotations

"""Observability: structured logging, request tracing, and error tracking.

- ``configure_logging`` installs a JSON log formatter on the root logger.
- ``RequestContextMiddleware`` stamps each request with a request id, logs an
  access line (method, path, status, duration), and returns ``X-Request-ID``.
- ``init_sentry`` enables Sentry error tracking + tracing when ``SENTRY_DSN`` is
  set and the SDK is installed (no-op otherwise).

All of this degrades gracefully: with nothing configured you still get plain,
structured logs instead of bare ``print``.
"""

import json
import logging
import os
import re
import time
import uuid
from typing import Any, Dict

# A request id we'll accept from a client verbatim (else we generate one).
_RID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

_access_log = logging.getLogger("agentlab.access")


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("request_id", "method", "path", "status", "duration_ms"):
            val = getattr(record, key, None)
            if val is not None:
                payload[key] = val
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    # Fall back to INFO on an unrecognized level instead of crashing at startup.
    level = logging.getLevelName(os.environ.get("AGENTLAB_LOG_LEVEL", "INFO").upper())
    if not isinstance(level, int):
        level = logging.INFO
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    # Uvicorn access logs are redundant with our middleware; quiet them.
    logging.getLogger("uvicorn.access").handlers = []


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        raw = request.headers.get("x-request-id", "")
        rid = raw if _RID_RE.match(raw) else uuid.uuid4().hex[:16]  # don't reflect arbitrary client input into logs
        start = time.perf_counter()
        # Seeded to 500 so an exception escaping the handler is still logged with a
        # status — the finally block below runs whether or not call_next returns.
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-ID"] = rid
            return response
        finally:
            _access_log.info(
                "request",
                extra={
                    "request_id": rid,
                    "method": request.method,
                    "path": request.url.path,
                    "status": status,
                    "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                },
            )


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Baseline security headers for every response.

    - nosniff / frame deny / referrer policy: cheap, always correct for a JSON
      API + self-hosted dashboard.
    - HSTS is opt-in via ``AGENTLAB_HSTS=1`` because uvicorn itself listens on
      plain HTTP; only enable it when all access is through the HTTPS tunnel.
    - ``Cache-Control: no-store`` on ``/api/*`` keeps session-scoped JSON out of
      shared caches; handlers may override (e.g. /api/status sets a short TTL).
    """

    _hsts = os.environ.get("AGENTLAB_HSTS", "").strip().lower() in {"1", "true", "yes"}

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        headers = response.headers
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "no-referrer")
        headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; "
            "form-action 'self'; object-src 'none'; img-src 'self' data: blob:; "
            "script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:",
        )
        if self._hsts:
            headers.setdefault("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
        if request.url.path.startswith("/api/"):
            headers.setdefault("Cache-Control", "no-store")
        return response


class RequestSizeLimitMiddleware:
    """Enforce a hard API request-body ceiling, including chunked requests.

    Written as raw ASGI rather than ``BaseHTTPMiddleware`` because the limit has to
    apply to a streamed body: a chunked request advertises no Content-Length, so the
    only way to cap it is to count bytes as they arrive off ``receive``.
    """

    def __init__(self, app, max_bytes: int = 1_048_576):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        try:
            length = int(headers.get(b"content-length", b"0") or b"0")
        except ValueError:
            # An unparseable Content-Length is treated as oversized rather than
            # ignored, so a malformed header cannot be used to skip the check.
            length = self.max_bytes + 1
        if length > self.max_bytes:
            await JSONResponse({"detail": "Request body too large."}, status_code=413)(scope, receive, send)
            return
        content_type = headers.get(b"content-type", b"").decode("latin-1").split(";", 1)[0].strip().lower()
        # JSON bodies are small by definition, so they are drained here in full: that
        # allows the size check to cover chunked uploads and lets a malformed body be
        # rejected as 400 before it reaches a handler. The bytes are then replayed to
        # the app (see replay_receive) since the stream can only be consumed once.
        if content_type == "application/json" or content_type.endswith("+json"):
            body = bytearray()
            more = True
            while more:
                message = await receive()
                if message.get("type") != "http.request":
                    continue
                body.extend(message.get("body", b""))
                if len(body) > self.max_bytes:
                    await JSONResponse({"detail": "Request body too large."}, status_code=413)(scope, receive, send)
                    return
                more = bool(message.get("more_body", False))
            if body:
                try:
                    # parse_constant rejects NaN/Infinity/-Infinity, which Python's
                    # json accepts but the JSON spec does not. They would otherwise
                    # reach a Pydantic float field and serialize back out as invalid
                    # JSON that a browser client cannot parse.
                    json.loads(
                        body,
                        parse_constant=lambda value: (_ for _ in ()).throw(
                            ValueError(f"non-standard JSON constant: {value}")
                        ),
                    )
                except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
                    await JSONResponse({"detail": "Invalid JSON body."}, status_code=400)(scope, receive, send)
                    return
            delivered = False

            async def replay_receive():
                nonlocal delivered
                if delivered:
                    # Hand back an empty terminal chunk rather than awaiting the real
                    # receive again, which is exhausted and would hang the request.
                    return {"type": "http.request", "body": b"", "more_body": False}
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}

            await self.app(scope, replay_receive, send)
            return
        # Non-JSON (uploads): don't buffer. Pass the stream through and abort the
        # moment the running total crosses the ceiling, so an oversized upload is
        # cut off mid-flight instead of being held in memory first.
        consumed = 0

        async def limited_receive():
            nonlocal consumed
            message = await receive()
            if message.get("type") == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > self.max_bytes:
                    raise _RequestBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _RequestBodyTooLarge:
            await JSONResponse({"detail": "Request body too large."}, status_code=413)(scope, receive, send)


class _RequestBodyTooLarge(Exception):
    pass


def init_sentry() -> bool:
    """Enable Sentry if SENTRY_DSN is set and the SDK is installed. Returns True if active."""
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            environment=os.environ.get("AGENTLAB_ENV", "production"),
        )
        return True
    except Exception:  # SDK missing or bad DSN — don't block startup
        logging.getLogger("agentlab").warning("Sentry DSN set but sentry_sdk unavailable; skipping.")
        return False
