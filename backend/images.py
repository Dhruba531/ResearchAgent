from __future__ import annotations

"""Figure / illustration generation for the paper (the PaperBanana "diagram" half).

PaperBanana splits figures two ways: statistical plots come from executable
Matplotlib code (which runs in the RunPod sandbox, see ``runpod_adapter``), while
methodology diagrams come from a text-to-image model. This module is that second
half — turn a text prompt into an image, store it as an ``Artifact``.

Providers (pick per the enabled image key):
  * ``gemini``: Gemini 2.5 Flash Image ("Nano Banana") via the Generative
    Language REST API; returns inline base64 PNG.
  * ``openai``: ``gpt-image-1`` via the Images API; returns base64 PNG.

httpx is imported lazily so the module loads with no optional deps.
"""

import base64
import os
import re
from typing import Callable, Dict, List

GEMINI_IMAGE_MODEL = os.environ.get("AGENTLAB_GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")
GEMINI_BASE = os.environ.get("AGENTLAB_GEMINI_BASE", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
OPENAI_IMAGE_MODEL = os.environ.get("AGENTLAB_OPENAI_IMAGE_MODEL", "gpt-image-1")

_FIGURE_LINE_RE = re.compile(r"^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)?\**\s*(figure\s*\d+\s*[:.\-—]\s*.+)$", re.I | re.M)


def max_figures() -> int:
    """Per-run figure ceiling (cost/abuse bound), operator-tunable."""
    try:
        return max(0, int(os.environ.get("AGENTLAB_MAX_FIGURES", "3")))
    except ValueError:
        return 3


def figure_prompts_from_draft(draft: str, title: str = "", limit: int = 3) -> List[str]:
    """Derive up to ``limit`` figure prompts from the draft.

    Prefers explicit "Figure N: caption" lines the writer already produced; falls
    back to a single overview diagram prompt from the title so a figure-enabled
    run still yields something. Pure + deterministic (unit-tested).
    """
    prompts: List[str] = []
    seen = set()
    for m in _FIGURE_LINE_RE.finditer(draft or ""):
        # Captions get normalised (whitespace collapsed, lowercased for the key)
        # because the same figure is usually mentioned twice — once at the insertion
        # point and once in a list of figures — and each duplicate would otherwise
        # be billed as another image.
        caption = " ".join(m.group(1).split())
        key = caption.lower()
        if key not in seen:
            seen.add(key)
            prompts.append(
                "Clean, publication-quality academic figure for a research paper. "
                f"{caption}. Minimal, labelled, white background, no photorealism."
            )
        if len(prompts) >= limit:
            break
    if not prompts and (title or "").strip():
        prompts.append(
            "Clean, publication-quality methodology diagram for the research paper "
            f'titled "{title.strip()}". Boxes-and-arrows overview of the approach, '
            "labelled, minimal, white background."
        )
    return prompts[:limit]


async def generate_figure(
    *,
    prompt: str,
    provider: str,
    api_key: str,
    index: int = 0,
    on_log: Callable[[str], None] = lambda _s: None,
) -> Dict:
    """Generate one figure. Returns a dict; never raises on a provider failure.

    ``{ok, provider, mime, ext, data (bytes), error}``. On any failure ``ok`` is
    False with ``error`` set, so the caller can log-and-continue (a missing figure
    must never fail the whole run).
    """
    if not api_key:
        return {"ok": False, "provider": provider, "mime": "", "ext": "", "data": b"",
                "error": "image provider key is required"}

    import httpx  # lazy

    try:
        provider = provider.lower()
        if provider == "gemini":
            url = f"{GEMINI_BASE}/models/{GEMINI_IMAGE_MODEL}:generateContent"
            async with httpx.AsyncClient(timeout=90.0) as client:
                r = await client.post(
                    url,
                    headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                    json={"contents": [{"parts": [{"text": prompt}]}]},
                )
                r.raise_for_status()
                for part in (((r.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or []):
                    inline = part.get("inlineData") or part.get("inline_data")
                    if inline and inline.get("data"):
                        return {"ok": True, "provider": "gemini", "mime": inline.get("mimeType", "image/png"),
                                "ext": "png", "data": base64.b64decode(inline["data"]), "error": ""}
                return {"ok": False, "provider": "gemini", "mime": "", "ext": "", "data": b"",
                        "error": "no inline image in Gemini response"}
        elif provider == "openai":
            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.post(
                    "https://api.openai.com/v1/images/generations",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={"model": OPENAI_IMAGE_MODEL, "prompt": prompt, "size": "1024x1024", "n": 1},
                )
                r.raise_for_status()
                b64 = ((r.json().get("data") or [{}])[0]).get("b64_json")
                if b64:
                    return {"ok": True, "provider": "openai", "mime": "image/png", "ext": "png",
                            "data": base64.b64decode(b64), "error": ""}
                return {"ok": False, "provider": "openai", "mime": "", "ext": "", "data": b"",
                        "error": "no b64_json in OpenAI response"}
        return {"ok": False, "provider": provider, "mime": "", "ext": "", "data": b"",
                "error": f"unsupported image provider: {provider}"}
    except Exception as exc:
        # Everything is caught, including HTTP errors: the failure is returned as
        # data so the runner logs "figure 2 unavailable" and finishes the paper. A
        # raise here would discard a completed draft over a missing illustration.
        # The message is truncated because it is persisted to the run log.
        return {"ok": False, "provider": provider, "mime": "", "ext": "", "data": b"",
                "error": f"{type(exc).__name__}: {str(exc)[:300]}"}
