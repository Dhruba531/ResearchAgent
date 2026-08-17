from __future__ import annotations

"""Provider adapters for AgentLab.

``PromptTemplateAdapter`` keeps the provider-agnostic prompt templates
(``agents.py``) reachable. ``stream_stage`` is the real integration: it runs a
single pipeline stage against **Anthropic (Claude)** or **OpenAI** using the
user's own API key, streaming output tokens to an ``on_text`` callback so the
runner can persist them as live logs.

Safety boundary: this module is only reached when a user has explicitly saved
**and enabled** a provider key (see ``app.create_run``). The agents may call the provider's hosted web-search
tool, but no user-generated code is ever executed locally.
"""

from typing import Any, Callable, Dict, List, Optional, Protocol, Sequence, Tuple

import agents

# Default model per provider when the saved key carries no explicit model name.
# Claude defaults to the latest Opus; OpenAI is usually set in the UI, but we
# fall back to a broadly-available model so a bare key still runs.
DEFAULT_MODELS: Dict[str, str] = {
    "anthropic": "claude-opus-4-8",
    "openai": "gpt-4o",
}

# Anthropic's dynamic-filtering web-search tool (``web_search_20260209``) is only
# valid on Opus 4.6+/Sonnet 4.6/Fable; older models need the basic variant.
_ANTHROPIC_DYNAMIC_SEARCH_MODELS = (
    "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-4-6", "fable", "mythos",
)


class BriefGenerator(Protocol):
    def generate(self, idea: str) -> Dict[str, Any]:
        ...


class ReviewerGenerator(Protocol):
    def generate(self, draft: str, category: str) -> Dict[str, str]:
        ...


class PromptTemplateAdapter:
    """Keeps the existing provider-agnostic prompt templates available."""

    def brief_prompt(self, idea: str):
        return agents.build_prompt("brief", {"idea": idea})

    def review_prompt(self, draft: str, category: str):
        return agents.build_prompt("review", {"draft": draft, "reviewer": category})


def resolve_model(provider: str, model_name: str) -> str:
    """Pick the model id for a stage: the saved name, else the provider default."""
    return (model_name or "").strip() or DEFAULT_MODELS.get((provider or "").lower(), "")


def _anthropic_tools(tools: Optional[List[Dict]], model: str) -> List[Dict]:
    """Translate agents.py's generic web-search tool to the model-correct variant."""
    if not tools:
        return []
    use_dynamic = any(tag in model for tag in _ANTHROPIC_DYNAMIC_SEARCH_MODELS)
    out: List[Dict] = []
    for tool in tools:
        ttype = str(tool.get("type", ""))
        if tool.get("name") == "web_search" or ttype.startswith("web_search"):
            out.append({
                "type": "web_search_20260209" if use_dynamic else "web_search_20250305",
                "name": "web_search",
                "max_uses": int(tool.get("max_uses", 5)),
            })
        else:
            out.append(tool)
    return out


async def _stream_anthropic(
    *, api_key: str, model: str, system: str, user: str, max_tokens: int,
    tools: Optional[List[Dict]], on_text: Callable[[str], None],
    should_cancel: Callable[[], bool],
) -> Tuple[str, int, int]:
    # Imported here, not at module scope: a deployment that only ever uses OpenAI
    # keys should not need the Anthropic SDK installed to import this module.
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=api_key)
    parts: List[str] = []
    kwargs: Dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        # Adaptive thinking improves multi-step research/writing quality; the raw
        # chain of thought is not surfaced (text_stream yields only answer text).
        "thinking": {"type": "adaptive"},
    }
    a_tools = _anthropic_tools(tools, model)
    if a_tools:
        kwargs["tools"] = a_tools
    in_tok = out_tok = 0
    try:
        async with client.messages.stream(**kwargs) as stream:
            async for text in stream.text_stream:
                if should_cancel():
                    # break, not return: control falls through to the usage read
                    # below so a cancelled stage still reports the tokens the
                    # provider already billed for.
                    break
                parts.append(text)
                on_text(text)
            final = await stream.get_final_message()
            if getattr(final, "stop_reason", None) == "refusal":
                raise RuntimeError("The model declined this request (safety refusal).")
            # Usage is read defensively: a stage that was cancelled or cut short can
            # come back without a usage block, and an unpriced stage must read as
            # zero tokens rather than crashing the run inside the cost ledger.
            usage = getattr(final, "usage", None)
            in_tok = int(getattr(usage, "input_tokens", 0) or 0)
            out_tok = int(getattr(usage, "output_tokens", 0) or 0)
    finally:
        # One client per stage, always closed — a long pipeline would otherwise leak
        # a connection pool per stage for the lifetime of the run.
        await client.close()
    return "".join(parts), in_tok, out_tok


async def _stream_openai(
    *, api_key: str, model: str, system: str, user: str, max_tokens: int,
    tools: Optional[List[Dict]], on_text: Callable[[str], None],
    should_cancel: Callable[[], bool],
) -> Tuple[str, int, int]:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=api_key)
    parts: List[str] = []
    kwargs: Dict[str, Any] = {
        "model": model,
        "instructions": system,
        "input": user,
        "max_output_tokens": max_tokens,
    }
    if tools:  # the agents pipeline only ever asks for web search
        kwargs["tools"] = [{"type": "web_search"}]
    in_tok = out_tok = 0
    try:
        async with client.responses.stream(**kwargs) as stream:
            # The Responses API streams a mixed event feed (tool calls, reasoning
            # summaries, lifecycle events); only text deltas are log-worthy, so
            # everything else is skipped rather than dispatched on.
            async for event in stream:
                if should_cancel():
                    break
                if getattr(event, "type", "") == "response.output_text.delta":
                    delta = getattr(event, "delta", "")
                    if delta:
                        parts.append(delta)
                        on_text(delta)
            final = await stream.get_final_response()
            usage = getattr(final, "usage", None)
            in_tok = int(getattr(usage, "input_tokens", 0) or 0)
            out_tok = int(getattr(usage, "output_tokens", 0) or 0)
    finally:
        await client.close()
    return "".join(parts), in_tok, out_tok


async def stream_stage(
    *, provider: str, api_key: str, model: str, system: str, user: str,
    max_tokens: int, tools: Optional[List[Dict]] = None,
    on_text: Callable[[str], None] = lambda _s: None,
    should_cancel: Callable[[], bool] = lambda: False,
) -> Tuple[str, int, int]:
    """Run one pipeline stage against a real provider; returns (text, in_tokens, out_tokens).

    ``on_text`` is invoked with each streamed chunk so the caller can persist
    progress; ``should_cancel`` is polled so a user-cancelled run stops promptly.
    """
    provider = (provider or "").lower()
    if provider == "anthropic":
        return await _stream_anthropic(
            api_key=api_key, model=model, system=system, user=user,
            max_tokens=max_tokens, tools=tools, on_text=on_text, should_cancel=should_cancel,
        )
    if provider == "openai":
        return await _stream_openai(
            api_key=api_key, model=model, system=system, user=user,
            max_tokens=max_tokens, tools=tools, on_text=on_text, should_cancel=should_cancel,
        )
    raise ValueError(f"Unsupported provider: {provider!r}")


async def embed_texts(
    *, api_key: str, texts: Sequence[str], model: str = "text-embedding-3-small",
) -> List[List[float]]:
    """Embed texts with OpenAI (default ``text-embedding-3-small``, 1536 dims).

    Used by the optional pgvector store for RAG. Embeddings are an OpenAI
    feature (Claude has no embeddings endpoint), so this always uses an OpenAI
    key regardless of which provider runs generation.
    """
    # Blank chunks are dropped before the call: the API rejects empty input strings,
    # and one stray empty chunk would fail the whole batch.
    items = [t for t in texts if t and t.strip()]
    if not items:
        return []
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=api_key)
    try:
        resp = await client.embeddings.create(model=model, input=items)
        return [item.embedding for item in resp.data]
    finally:
        await client.close()
