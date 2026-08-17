from __future__ import annotations

"""Deterministic groundedness checks — anti-hallucination that does NOT trust the model.

The Citation Verifier agent already *claims* which sources are real, but a model
can lie about its own honesty. These checks verify mechanically:

  * **URL liveness** — every cited URL is actually fetched; a link that 404s (or
    never resolves) is a fabricated source, full stop. No LLM judgement involved.
  * **Unresolved placeholders** — leftover ``[CITATION NEEDED: …]`` markers that
    slipped into the final draft.
  * **Self-flagged fabrications** — items the Verifier itself listed under
    "Unsupported or Fabricated".

These roll up into a 0–1 ``score`` and a ``verified`` bool that the export gate
(``app.approve_final``) enforces. Everything here is pure/offline except
``check_urls`` (network), which is env-gated so CI never hits the wire.
"""

import asyncio
import ipaddress
import os
import re
import socket
from typing import Dict, List, Optional
from urllib.parse import urljoin, urlparse, urlunparse

_URL_RE = re.compile(r"https?://[^\s<>()\[\]\"'`]+", re.I)
_PLACEHOLDER_RE = re.compile(r"\[CITATION NEEDED[^\]]*\]", re.I)
_LIST_ITEM_RE = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+\S")


def verify_urls_enabled() -> bool:
    """Real URL fetching is on by default but can be disabled (CI/offline)."""
    return os.environ.get("AGENTLAB_VERIFY_URLS", "1").strip().lower() in {"1", "true", "yes"}


def extract_urls(*texts: str, limit: int = 60) -> List[str]:
    """Unique http(s) URLs across the given texts, order-preserved, trailing punct stripped."""
    seen = set()
    out: List[str] = []
    for text in texts:
        for m in _URL_RE.finditer(text or ""):
            # Prose puts the sentence's punctuation right against the URL
            # ("see https://example.com/paper."), and the trailing period would
            # otherwise be fetched as part of the path and scored as a dead link.
            url = m.group(0).rstrip(".,);]'\"")
            if url not in seen:
                seen.add(url)
                out.append(url)
                if len(out) >= limit:
                    return out
    return out


def count_placeholders(text: str) -> int:
    """Number of unresolved [CITATION NEEDED …] markers left in the text."""
    return len(_PLACEHOLDER_RE.findall(text or ""))


def _section_body(text: str, heading_substr: str) -> str:
    """Return the lines under the first markdown heading containing ``heading_substr``.

    Substring matching rather than an exact heading: the agent's heading level and
    wording drift between runs ("## Unsupported or Fabricated Claims", "### 3.
    Unsupported or Fabricated"), and only the section body matters here.
    """
    marker = heading_substr.lower()
    out: List[str] = []
    capturing = False
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("#") and marker in stripped.lower():
            capturing = True
            continue
        if capturing and stripped.startswith("#"):
            break  # any following heading, at any level, ends the section
        if capturing:
            out.append(line)
    return "\n".join(out).strip()


def fabricated_flags(citation_audit: str) -> int:
    """Count items the Citation Verifier listed as unsupported/fabricated.

    Reads its "Unsupported or Fabricated" section and counts list items, treating
    an explicit 'none'/'n/a' as zero.
    """
    body = _section_body(citation_audit, "unsupported or fabricated")
    if not body:
        return 0
    items = [ln for ln in body.splitlines() if _LIST_ITEM_RE.match(ln)]
    low = body.lower()
    if not items:
        return 0
    # A clean audit often writes its "nothing to report" as a single bullet
    # ("- None"), which would otherwise be counted as one fabrication and block
    # export. Only collapse to zero for a *single* item, so a real finding that
    # merely mentions the word "none" in its text still counts.
    if len(items) <= 1 and any(k in low for k in ("none", "no unsupported", "n/a", "nothing")):
        return 0
    return len(items)


async def check_urls(urls: List[str], timeout: float = 8.0, concurrency: int = 6) -> Dict[str, Optional[bool]]:
    """Map each URL to True (reachable), False (dead/unreachable), or None (unchecked).

    HEAD first, GET fallback (many sites reject HEAD). Best-effort — any error is
    treated as dead. Returns all-None when disabled so the caller degrades cleanly.
    """
    if not urls or not verify_urls_enabled():
        return {u: None for u in urls}
    import httpx  # lazy

    async def pinned_public_target(url: str):
        """Resolve a URL once and return a public-IP-pinned request target.

        Citation URLs come from model output, so treating them as trusted would
        turn the verifier into an SSRF primitive. Every DNS answer must be
        public, and the HTTP connection is made to one of those exact resolved
        addresses while retaining the original Host header and TLS SNI. This
        closes the validation/request DNS-rebinding gap.
        """
        try:
            parsed = urlparse(url)
            if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
                return False
            if parsed.username is not None or parsed.password is not None:
                return False
            port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
            host = parsed.hostname.encode("idna").decode("ascii")
            try:
                addresses = [ipaddress.ip_address(host)]
            except ValueError:
                answers = await asyncio.to_thread(
                    socket.getaddrinfo,
                    host,
                    port,
                    type=socket.SOCK_STREAM,
                )
                addresses = []
                for answer in answers:
                    raw = str(answer[4][0]).split("%", 1)[0]
                    addresses.append(ipaddress.ip_address(raw))
            # Every answer must be public, not just the one we connect to: a
            # hostname that resolves to both a public and a private address would
            # otherwise pass the check and still be reachable internally on a retry.
            if not addresses or not all(address.is_global for address in addresses):
                return None
            address = addresses[0]
            ip_host = f"[{address}]" if address.version == 6 else str(address)
            explicit_port = parsed.port is not None
            netloc = f"{ip_host}:{port}" if explicit_port else ip_host
            path = parsed.path or "/"
            pinned = urlunparse((parsed.scheme.lower(), netloc, path, parsed.params, parsed.query, ""))
            default_port = 443 if parsed.scheme.lower() == "https" else 80
            host_header = f"{host}:{port}" if explicit_port and port != default_port else host
            return pinned, host_header, host
        except (OSError, TypeError, ValueError):
            return None

    result: Dict[str, Optional[bool]] = {}
    sem = asyncio.Semaphore(concurrency)
    # Redirects are followed manually so every hop gets the same DNS/IP check.
    # Ignore proxy environment variables: a proxy could otherwise resolve a
    # public-looking hostname to an internal destination on the app's behalf.
    limits = httpx.Limits(max_keepalive_connections=0, max_connections=concurrency)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False, limits=limits) as client:
        async def request_once(method: str, url: str):
            target = await pinned_public_target(url)
            if target is None:
                return None
            pinned, host_header, sni_hostname = target
            req = client.build_request(
                method,
                pinned,
                headers={
                    "Host": host_header,
                    "Accept-Encoding": "identity",
                    "Range": "bytes=0-0",
                    "Connection": "close",
                },
                extensions={"sni_hostname": sni_hostname},
            )
            # Streaming mode reads only response headers. Citation liveness does
            # not need the body, so an attacker cannot force an unbounded body
            # allocation through a cited URL.
            response = await client.send(req, stream=True)
            try:
                return response.status_code, response.headers.get("location")
            finally:
                await response.aclose()

        async def request(method: str, original_url: str):
            current = original_url
            for _ in range(6):  # initial request + at most five redirects
                response = await request_once(method, current)
                if response is None:
                    return None
                status_code, location = response
                if status_code not in {301, 302, 303, 307, 308}:
                    return status_code
                if not location:
                    return status_code
                current = urljoin(current, location)
            return None

        async def probe(u: str) -> None:
            async with sem:
                try:
                    response = await request("HEAD", u)
                    # Publishers routinely refuse HEAD (405) or gate it behind a bot
                    # check (403), so any error status is retried with GET before the
                    # source is called dead. False positives here would fail export
                    # on a citation that is genuinely fine.
                    if response is not None and (response in (403, 405) or response >= 400):
                        response = await request("GET", u)
                    result[u] = response is not None and response < 400
                except Exception:
                    result[u] = False
        await asyncio.gather(*(probe(u) for u in urls))
    return result


def score(dead: int, placeholders: int, fabricated: int) -> float:
    """Blend the three penalties into a 0–1 groundedness score (1.0 = clean)."""
    # Weights rank the failures by how much they mislead a reader: a self-flagged
    # fabrication is worst, a dead link next, an unresolved placeholder least (it is
    # at least visibly incomplete). The score is advisory — the export gate keys on
    # the `verified` bool in assess(), which requires all three to be zero.
    s = 1.0 - 0.12 * dead - 0.10 * placeholders - 0.15 * fabricated
    return round(max(0.0, min(1.0, s)), 3)


async def assess(draft: str, citation_audit: str) -> dict:
    """Full groundedness report for a finished draft + its citation audit."""
    urls = extract_urls(citation_audit, draft)
    liveness = await check_urls(urls)
    # Three-state on purpose: `is False` means proven dead, while None means never
    # checked (verification disabled, or the URL failed the SSRF guard). Only proven
    # failures are penalised, so an offline environment cannot fabricate a low score.
    dead_urls = [u for u, ok in liveness.items() if ok is False]
    checked = sum(1 for ok in liveness.values() if ok is not None)
    placeholders = count_placeholders(draft)
    fabricated = fabricated_flags(citation_audit)
    return {
        "score": score(len(dead_urls), placeholders, fabricated),
        "urls_total": len(urls),
        "urls_checked": checked,
        "urls_dead": len(dead_urls),
        "dead_urls": dead_urls[:20],
        "placeholders": placeholders,
        "fabricated_flags": fabricated,
        # "verified" is what the export gate keys on: nothing mechanically wrong.
        "verified": len(dead_urls) == 0 and placeholders == 0 and fabricated == 0,
    }
