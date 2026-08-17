from __future__ import annotations

"""Execute generated experiment code on RunPod — the isolated GPU sandbox.

This deliberately relaxes the platform's "never execute generated code" rule, so
it is wrapped in hard safety controls enforced by the caller (``real_runner``):

  * operator capability flag ``AGENTLAB_ALLOW_EXECUTION`` (off by default),
  * a saved + enabled per-user ``runpod`` provider key,
  * explicit per-run opt-in (``config_json {"execute": true}``),
  * a dollar budget → wall-clock cap (``cost.max_runtime_seconds``),
  * guaranteed job teardown, and never running on the Mac Mini host.

Execution uses RunPod **Serverless** REST: POST the code to the user's
``python-runner`` endpoint and poll ``/status`` until done or the cap is hit.
Serverless gives job-level timeouts/cost controls and needs no SSH or manual pod
teardown. A RunPod API key and endpoint id are mandatory.

Heavy/optional imports (httpx) are lazy so the module imports with no deps.
"""

import asyncio
import logging
import os
import re
import time
from typing import Callable, Dict, List, Optional

# Serverless base; the endpoint id is per-user (their deployed python-runner).
RUNPOD_SERVERLESS_BASE = os.environ.get("RUNPOD_SERVERLESS_BASE", "https://api.runpod.ai/v2").rstrip("/")

_CODE_FENCE_RE = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.S | re.I)
_ENDPOINT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_log = logging.getLogger("agentlab.runpod")


def valid_endpoint_id(endpoint_id: str) -> bool:
    # The endpoint id is user-supplied and gets interpolated straight into the
    # request URL, so it is whitelisted to id-safe characters: a value containing
    # "/" or ".." could otherwise retarget the call at another RunPod path.
    return bool(_ENDPOINT_ID_RE.fullmatch((endpoint_id or "").strip()))


def allow_execution() -> bool:
    """Operator capability flag — code execution is impossible unless this is on."""
    return os.environ.get("AGENTLAB_ALLOW_EXECUTION", "").strip().lower() in {"1", "true", "yes"}


def extract_python_code(*texts: str) -> str:
    """Concatenate the ```python fenced blocks found across the given texts.

    The experiment plan/draft is prose with code blocks; only fenced Python is
    ever executed. No fenced Python => empty string => the caller skips execution
    (nothing runnable was proposed), which is the safe default.
    """
    blocks: List[str] = []
    for text in texts:
        for m in _CODE_FENCE_RE.finditer(text or ""):
            block = m.group(1).strip()
            if block:
                blocks.append(block)
    # Blocks are joined into one script (rather than run separately) because later
    # blocks in a plan normally depend on the imports and variables of earlier ones.
    return "\n\n# ---\n\n".join(blocks)


async def run_experiment(
    *,
    code: str,
    api_key: str = "",
    endpoint_id: str = "",
    requirements: str = "",
    gpu_type: str = "rtx 4090",
    max_seconds: int = 300,
    on_log: Callable[[str], None] = lambda _s: None,
    on_submitted: Callable[[str], None] = lambda _job_id: None,
    should_cancel: Callable[[], bool] = lambda: False,
    poll_interval: float = 3.0,
) -> Dict:
    """Run ``code`` on the sandbox and return a structured result dict.

    Never raises for an execution failure — a failed/cancelled/timed-out job is
    reported in the returned ``status``/``ok`` so the caller can record it and
    carry on. Only truly unexpected states surface as ``ok=False`` with a reason.
    """
    if not code.strip():
        return {"ok": False, "mode": "real", "status": "NO_CODE", "exit_code": None,
                "seconds": 0.0, "stdout": "", "stderr": "no runnable code found", "artifacts": []}
    max_seconds = max(1, int(max_seconds))
    started = time.monotonic()

    if not api_key or not endpoint_id:
        return {"ok": False, "mode": "real", "status": "NOT_CONFIGURED", "exit_code": None,
                "seconds": 0.0, "stdout": "",
                "stderr": "real execution needs a RunPod api_key + endpoint_id", "artifacts": []}
    if not valid_endpoint_id(endpoint_id):
        return {"ok": False, "mode": "real", "status": "INVALID_ENDPOINT", "exit_code": None,
                "seconds": 0.0, "stdout": "", "stderr": "invalid RunPod endpoint id", "artifacts": []}

    import httpx  # lazy

    base = f"{RUNPOD_SERVERLESS_BASE}/{endpoint_id}"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    # The python-runner endpoint contract: input.code (+ optional requirements),
    # executionTimeout in ms bounds the worker; we also enforce our own wall clock.
    payload = {
        "input": {"code": code, "requirements": requirements},
        "policy": {"executionTimeout": max_seconds * 1000},
    }
    job_id = ""
    async with httpx.AsyncClient(timeout=30.0) as client:
        async def cancel_submitted_job() -> None:
            """Best-effort remote teardown while the HTTP client is still open."""
            if not job_id:
                return
            try:
                await client.post(f"{base}/cancel/{job_id}", headers=headers)
            except Exception as exc:
                _log.warning("RunPod cancellation failed for job %s: %s", job_id, type(exc).__name__)

        try:
            r = await client.post(f"{base}/run", headers=headers, json=payload)
            r.raise_for_status()
            job_id = (r.json() or {}).get("id", "")
            if not job_id:
                return {"ok": False, "mode": "real", "status": "ERROR", "exit_code": None,
                        "seconds": round(time.monotonic() - started, 2), "stdout": "",
                        "stderr": "RunPod submission response did not include a job id", "artifacts": []}
            on_submitted(job_id)
            on_log(f"RunPod job submitted (id={job_id or 'unknown'}). Polling for results…")
            while True:
                # Two independent stops: the user cancelling, and our own wall clock.
                # The local clock is checked even though the job carries a RunPod-side
                # executionTimeout, because that timeout bounds the worker, not this
                # poll loop — a stuck or unreachable endpoint would otherwise bill
                # against the approved budget indefinitely.
                if should_cancel() or (time.monotonic() - started) > max_seconds:
                    await client.post(f"{base}/cancel/{job_id}", headers=headers)
                    reason = "cancelled" if should_cancel() else "exceeded time/cost cap"
                    return {"ok": False, "mode": "real", "status": "CANCELLED", "exit_code": None,
                            "seconds": round(time.monotonic() - started, 2), "stdout": "",
                            "stderr": f"job {reason}; RunPod worker cancelled", "artifacts": []}
                s = await client.get(f"{base}/status/{job_id}", headers=headers)
                s.raise_for_status()
                body = s.json() or {}
                status = str(body.get("status", "")).upper()
                if status in ("COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"):
                    out = body.get("output") or {}
                    return {
                        "ok": status == "COMPLETED",
                        "mode": "real",
                        "status": status,
                        "exit_code": out.get("exit_code"),
                        "seconds": round(time.monotonic() - started, 2),
                        # Truncated before it ever reaches the database: a runaway
                        # training loop can emit megabytes of progress output, and
                        # the tail is what a failure diagnosis needs anyway.
                        "stdout": str(out.get("stdout", ""))[:20000],
                        "stderr": str(out.get("stderr", ""))[:8000],
                        "artifacts": out.get("artifacts", []) if isinstance(out.get("artifacts"), list) else [],
                    }
                await asyncio.sleep(poll_interval)
        except asyncio.CancelledError:
            # asyncio.CancelledError inherits BaseException, so the generic error
            # handler below does not see it.  Shield teardown from this task's
            # cancellation; then propagate cancellation to the runner as normal.
            try:
                await asyncio.shield(asyncio.wait_for(cancel_submitted_job(), timeout=10.0))
            except BaseException:
                pass
            raise
        except Exception as exc:
            # Best-effort cancel so a submitted job never lingers/bills after an error.
            await cancel_submitted_job()
            return {"ok": False, "mode": "real", "status": "ERROR", "exit_code": None,
                    "seconds": round(time.monotonic() - started, 2), "stdout": "",
                    "stderr": f"{type(exc).__name__}: {str(exc)[:300]}", "artifacts": []}


async def cancel_job(*, api_key: str, endpoint_id: str, job_id: str) -> bool:
    """Best-effort cancellation for a persisted job orphaned by a restart."""
    if not api_key or not valid_endpoint_id(endpoint_id) or not job_id:
        return False
    import httpx

    base = f"{RUNPOD_SERVERLESS_BASE}/{endpoint_id}"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(f"{base}/cancel/{job_id}", headers=headers)
            # 404 counts as success: the job is already gone (finished or reaped),
            # which is exactly the state this call is trying to reach.
            return response.status_code < 400 or response.status_code == 404
    except Exception as exc:
        _log.warning("Orphaned RunPod cancellation failed for job %s: %s", job_id, type(exc).__name__)
        return False
