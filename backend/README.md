# Backend modules

Python modules from the AgentLab research-agent service (FastAPI + SQLAlchemy).

This is a **subset of the service, not a runnable app** — the HTTP route layer and
the pipeline runner are not included here. What is here are the supporting modules
they are built on: the data model, the request/response contracts, auth, secret
handling, cost governance, provider integration, and the deterministic
groundedness checks.

## Layout

| Module | What it does |
| --- | --- |
| `models.py` | SQLAlchemy schema for the governed workflow — projects, briefs, runs, approvals, campaigns. The invariants (which gate blocks what) are documented at the top. |
| `schemas.py` | Pydantic request/response contracts for the `/api` surface, including the input bounds that protect the cost gates. |
| `database.py` | Engine/session setup and the durable paths. SQLite by default, Postgres via `AGENTLAB_DATABASE_URL`. |
| `auth.py` | PBKDF2 password hashing, server-side sessions behind an HTTP-only cookie, and the `current_user` dependency. |
| `supabase_auth.py` | Supabase JWT verification (legacy HS256 and rotating RS256/ES256 via JWKS), plus first-login user provisioning. |
| `crypto.py` | Fernet encryption for provider API keys at rest, with a strict mode that refuses to store plaintext in production. |
| `ratelimit.py` | Fixed-window rate limiting for the expensive and credential-facing endpoints. |
| `observability.py` | JSON logging, request-id tracing, security headers, and a request-body size ceiling that also covers chunked uploads. |
| `cost.py` | Token/GPU/image price tables, the pre-flight run estimate, and the monthly per-user spend cap. |
| `agents.py` | The pipeline's agent definitions — one persona and prompt per stage, with per-stage token and web-search budgets. |
| `provider_adapters.py` | Streaming a single pipeline stage against Anthropic or OpenAI on the user's own key, returning real token usage for metering. |
| `groundedness.py` | Anti-hallucination checks that do not trust the model: every cited URL is actually fetched (behind an SSRF guard), placeholders and self-flagged fabrications are counted. |
| `vector_store.py` | Optional pgvector store for RAG grounding and cross-run memory; a no-op when no vector database is configured. |
| `images.py` | Figure generation via Gemini or `gpt-image-1`; a failed figure is returned as data so it never fails a finished paper. |
| `runpod_adapter.py` | Running generated experiment code on RunPod Serverless, under a wall-clock cap derived from the approved dollar budget. |
| `runner_common.py` | WebSocket fan-out for live run logs, and artifact path handling that rejects traversal. |

## Configuration

Everything is environment-driven; the defaults are chosen so a local checkout runs
with no external services. The variables that matter most in a real deployment:

| Variable | Purpose |
| --- | --- |
| `AGENTLAB_DATABASE_URL` | Postgres instead of the local SQLite file. Also enables the pgvector store when set to a Postgres URL. |
| `AGENTLAB_SECRET_KEY` | Fernet key for encrypting provider API keys. Required once `AGENTLAB_ENV` is `production`/`staging`. |
| `AGENTLAB_USER_MONTHLY_CAP_USD` | Per-user monthly spend cap (default `50`). |
| `AGENTLAB_ALLOW_EXECUTION` | Operator flag; code execution is impossible unless this is on. |
| `AGENTLAB_VERIFY_URLS` | Set to `0` to skip live URL fetching (offline/CI). |
| `SUPABASE_JWT_SECRET` / `SUPABASE_JWT_ISS` | Enable Supabase bearer-token auth alongside the cookie session. |

Generate a secret key with:

```sh
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## Dependencies

`requirements.in` is the dependency source. The pinned, hash-locked
`requirements.txt` used for deployment is generated from it:

```sh
uv pip compile --python-version 3.11 --generate-hashes \
  backend/requirements.in -o backend/requirements.txt
```
