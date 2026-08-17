from __future__ import annotations

"""In-process rate limiting for abuse protection.

A fixed-window counter keyed per (bucket, identity) — applied to the expensive
LLM run endpoint and the provider-key write/test endpoints. Limits are
env-tunable. This is single-process; for horizontally-scaled deployments swap the
store for Redis (same ``enforce`` signature).
"""

import os
import threading
import time
from collections import defaultdict
from typing import Dict, List

from fastapi import HTTPException

_lock = threading.Lock()
_hits: Dict[str, List[float]] = defaultdict(list)
_max_window = 0  # largest window seen; used to bound the sweep below

# Defaults (requests per window). Tune via env per deployment.
RUN_LIMIT = int(os.environ.get("AGENTLAB_RUN_RATE_LIMIT", "20"))
RUN_WINDOW_S = int(os.environ.get("AGENTLAB_RUN_RATE_WINDOW_S", "3600"))
KEY_LIMIT = int(os.environ.get("AGENTLAB_KEY_RATE_LIMIT", "30"))
KEY_WINDOW_S = int(os.environ.get("AGENTLAB_KEY_RATE_WINDOW_S", "3600"))
# Credential endpoints (login/register) — slows brute-force and enumeration.
AUTH_LIMIT = int(os.environ.get("AGENTLAB_AUTH_RATE_LIMIT", "20"))
AUTH_WINDOW_S = int(os.environ.get("AGENTLAB_AUTH_RATE_WINDOW_S", "900"))
# Paid prompt-based paper revision previews, per authenticated account.
REVISION_LIMIT = int(os.environ.get("AGENTLAB_REVISION_RATE_LIMIT", "30"))
REVISION_WINDOW_S = int(os.environ.get("AGENTLAB_REVISION_RATE_WINDOW_S", "3600"))
# Provider-backed research brief generation.
BRIEF_LIMIT = int(os.environ.get("AGENTLAB_BRIEF_RATE_LIMIT", "30"))
BRIEF_WINDOW_S = int(os.environ.get("AGENTLAB_BRIEF_RATE_WINDOW_S", "3600"))


def enforce(key: str, limit: int, window_s: int) -> None:
    """Raise HTTP 429 if ``key`` has exceeded ``limit`` requests in ``window_s``."""
    if limit <= 0:
        return
    global _max_window
    # monotonic(), not time(): an NTP correction or a manual clock change must not
    # hand a caller a free window or lock them out for hours.
    nowt = time.monotonic()
    cutoff = nowt - window_s
    with _lock:
        _max_window = max(_max_window, window_s)
        # Opportunistic sweep so one-shot/idle users' keys don't accumulate forever.
        if len(_hits) > 1000:
            stale = nowt - _max_window
            for k in [k for k, v in _hits.items() if not v or v[-1] < stale]:
                _hits.pop(k, None)
        kept = [t for t in _hits.get(key, ()) if t >= cutoff]  # .get avoids creating empty keys
        if len(kept) >= limit:
            # Retry-After is measured from the oldest surviving hit, which is the
            # moment a slot actually frees up as the window slides forward.
            retry = max(1, int(window_s - (nowt - kept[0])) + 1)
            _hits[key] = kept
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded — try again in ~{retry}s.",
                headers={"Retry-After": str(retry)},
            )
        kept.append(nowt)
        _hits[key] = kept


def reset() -> None:
    """Clear all counters (used by tests)."""
    with _lock:
        _hits.clear()
