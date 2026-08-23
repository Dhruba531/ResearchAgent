# Code Overview — ResearchAgent

A file-by-file map of the Python codebase: what each module is, what it holds, and
how the pieces fit together.

**Scale:** 31 Python files, 13,222 lines. Plus a TypeScript/React frontend
(81 `.tsx`, 16 `.ts`) sharing the repository.

---

## What this project is

A **governed AI research pipeline**. A user states a research idea; the system
generates a structured brief, requires a human to approve it, estimates the dollar
cost, requires approval of that budget, then runs a multi-stage LLM agent pipeline
that plans, drafts, reviews, and revises a paper — with anti-hallucination checks
and a final human sign-off before export.

Two ideas drive the whole design:

1. **Human gates.** Approval is required at brief, budget, and final export. Code
   cannot skip them.
2. **Real money.** Every run spends the user's own provider credits, so cost
   estimation, budget reservation, and spend caps are first-class concerns rather
   than afterthoughts.

---

## The request pipeline at a glance

```
   HTTP request
        │
        ▼
  observability.py   request-id, JSON logs, security headers, body-size ceiling
        │
        ▼
  ratelimit.py       fixed-window caps on auth / brief / run / key endpoints
        │
        ▼
  auth.py  ·  supabase_auth.py     session cookie OR Supabase JWT → current_user
        │
        ▼
  app.py             52 routes: validate (schemas.py) → enforce gates → persist (models.py)
        │
        ▼
  real_runner.py     the pipeline: plan → draft → review → revise
        │                │
        │                ├── agents.py             per-stage persona + prompt + budget
        │                ├── provider_adapters.py  streams to Anthropic / OpenAI
        │                ├── cost.py               meters tokens, enforces the cap
        │                ├── groundedness.py       fetches every cited URL
        │                ├── runpod_adapter.py     runs generated experiment code
        │                └── images.py             generates figures
        ▼
  runner_common.py   WebSocket log fan-out, traversal-safe artifact writes
```

---

## File-by-file

### Entry point

| File | Lines | What it is |
|---|---|---|
| `app.py` | 2,392 | The FastAPI application: **52 routes**, startup/shutdown lifespan, CSRF origin guard, and the response serialisers. |
| `backend/app.py` | 2,392 | **A byte-identical copy of the above** (verified by MD5). See "Findings" below. |

The route surface, grouped:

- **Auth** — `register`, `login`, `logout`, `me`
- **Projects** — CRUD, `archive`, `idea`
- **Briefs** — `generate`, `PATCH`, `approve` ← *human gate 1*
- **Runs** — `estimate` ← *human gate 2*, `create`, `cancel`, log WebSocket
- **Revisions** — `estimate`, `preview`, `apply`
- **Campaigns** — create, `stop`, candidates, `leaderboard`, `frontier`, trace WebSocket
- **Candidates** — `promote`, `reject`, `audit`, `trace`
- **Provider keys** — list, save, `test`, delete
- **Final** — `final/approve` ← *human gate 3*
- **Ops** — `/health`, `/health/live`, `/health/ready`, `/api/status`, `/api/capabilities`

`lifespan` does real work on boot: `_validate_deployment_security` refuses to
start with unsafe production config, `_encrypt_legacy_provider_keys` migrates
plaintext keys, and `_recover_interrupted_runs` reclaims runs orphaned by a crash.

### Data and contracts

| File | Lines | What it is |
|---|---|---|
| `backend/models.py` | 400 | SQLAlchemy schema — **15 tables**: `User`, `AuthSession`, `ProviderKey`, `Project`, `Brief`, `AgentSession`, `Run`, `PaperRevision`, `Campaign`, `Candidate`, `RunLog`, `Artifact`, `ReviewFinding`, `Approval`, `StatusHistory`. Workflow invariants (which gate blocks what) are documented at the top. |
| `backend/schemas.py` | 465 | **42 Pydantic models** defining every request/response shape. Also where input bounds live — the numeric limits that stop a malformed request from blowing past a cost gate. |
| `backend/database.py` | 71 | Engine and session setup. SQLite by default, Postgres via `AGENTLAB_DATABASE_URL`. |
| `backend/migrations/versions/0004_…` | 69 | Removes the publicly-known legacy demo account. Idempotent. |
| `backend/migrations/versions/0005_…` | 80 | Adds the `campaigns` / `candidates` archive tables. |

### Security

| File | Lines | What it is |
|---|---|---|
| `backend/auth.py` | 165 | PBKDF2 password hashing, server-side sessions behind an HTTP-only cookie, and the `current_user` dependency every protected route depends on. |
| `backend/supabase_auth.py` | 228 | The alternative path: Supabase JWT verification — legacy HS256 plus rotating RS256/ES256 via JWKS — and first-login user provisioning. |
| `backend/crypto.py` | 119 | Fernet encryption for provider API keys at rest. Has a **strict mode that refuses to store plaintext in production** (`SecretConfigurationError`). |
| `backend/ratelimit.py` | 73 | Fixed-window rate limiting on the expensive and credential-facing endpoints. |
| `backend/observability.py` | 234 | JSON logging, request-id tracing, security headers, and a request-body size ceiling that also covers chunked uploads. |

### The pipeline

| File | Lines | What it is |
|---|---|---|
| `backend/real_runner.py` | 1,765 | **The engine.** `RealAgentRunner` executes the staged pipeline, parses agent decisions (`parse_action`, `parse_subtasks`), scores reviews, enforces `budget_breach`, and drives the orchestrator-worker "research swarm". The second-largest file and the most behaviourally dense. |
| `backend/agents.py` | 536 | One persona and prompt per stage — `_brief`, `_plan`, `_draft`, `_review`, `_verify`, `_revise`, `_orchestrate`, `_advise`, `_delegate`, `_investigate`, `_synthesize` — each with its own token and web-search budget. `build_prompt` assembles them. |
| `backend/provider_adapters.py` | 215 | Streams one pipeline stage against Anthropic or OpenAI **on the user's own key**, returning real token usage for metering. Also `embed_texts` for the vector store. |
| `backend/runner_common.py` | 74 | `ConnectionManager` fans out live run logs over WebSockets; `safe_artifact_path` rejects path traversal. |

### Cost governance

| File | Lines | What it is |
|---|---|---|
| `backend/cost.py` | 371 | Price tables for tokens, GPU-hours, and images. `estimate_real_run` produces the pre-flight number shown at the budget gate; `monthly_spend` / `over_budget` / `remaining_budget` enforce the per-user monthly cap. |

### Quality and grounding

| File | Lines | What it is |
|---|---|---|
| `backend/groundedness.py` | 256 | **Anti-hallucination, and it does not trust the model.** Every cited URL is actually fetched (behind an SSRF guard that blocks private and DNS-resolved-private targets); placeholders and self-flagged fabrications are counted; `assess` produces the score that can block export. |
| `backend/vector_store.py` | 189 | Optional pgvector store for RAG grounding and cross-run memory. A no-op when no vector database is configured. |

### Execution and output

| File | Lines | What it is |
|---|---|---|
| `backend/runpod_adapter.py` | 196 | Runs generated experiment code on RunPod Serverless, under a wall-clock cap derived from the approved dollar budget. Gated behind an explicit operator flag. |
| `backend/images.py` | 131 | Figure generation via Gemini or `gpt-image-1`. A failed figure is returned as data so it never fails an otherwise finished paper. |

### Tests

10 files, 2,801 lines, 127 tests — organised by the phase of work that introduced them:

| File | Tests | Covers |
|---|---|---|
| `test_p2_hardening.py` | 24 | Provider-only runs, per-stage budgets, export scoping, auth rate limits, DB constraints |
| `test_p3_production.py` | 6 | Revise-stage outputs, security headers, fail-closed secret encryption |
| `test_p4_agentic.py` | 10 | Action gating, decision parsing, score extraction |
| `test_p6_execution_figures.py` | 12 | RunPod execution, figure generation, path-traversal rejection |
| `test_p7_groundedness.py` | 11 | URL/placeholder parsing, SSRF blocking, the export gate |
| `test_p10_recovery_readiness.py` | 9 | Crash recovery, graceful shutdown, truthful cost, readiness probes |
| `test_p13_campaigns.py` | 17 | Campaign gates, owner scoping, ranking, archive safety |
| `test_p14_bugfixes.py` | 10 | Regressions from review findings |
| `test_p15_research_swarm.py` | 19 | Delegation, parallelism, fan-out caps, governance |
| `test_p17_concurrent_failure_and_cost.py` | 9 | Two bugs that cost real money, and the regressions pinning them |

---

## Configuration

Everything is environment-driven — **47 `AGENTLAB_*` variables** — with defaults
chosen so a local checkout runs with no external services. The ones that change
behaviour most:

| Variable | Effect |
|---|---|
| `AGENTLAB_DATABASE_URL` | Postgres instead of local SQLite; also enables pgvector |
| `AGENTLAB_SECRET_KEY` | Fernet key for provider-key encryption. **Required** once `AGENTLAB_ENV` is `production`/`staging` |
| `AGENTLAB_ENV` | Switches on the strict production validations |
| `AGENTLAB_ALLOW_EXECUTION` | Operator flag gating RunPod code execution |
| `AGENTLAB_VERIFY_URLS` | Turns real URL fetching on for groundedness |
| `AGENTLAB_USER_MONTHLY_CAP_USD` | The per-user monthly spend ceiling |

---

## Findings from reading the code

1. **`app.py` is duplicated.** The root `app.py` and `backend/app.py` are
   byte-identical (MD5 `121a9ef2…`), 2,392 lines each. The tests import the
   `backend/` copy (they `sys.path.insert` the backend directory); a deployment
   may well run the root one. Nothing keeps them in sync, so a fix applied to one
   silently misses the other. Worth collapsing to a single module.

2. **`app.py` and `real_runner.py` hold most of the complexity** — 4,157 lines
   between them, 32% of the Python codebase in two files. `app.py` alone has 92
   top-level functions.

3. **`backend/README.md` describes the directory as "a subset of the service, not
   a runnable app"**, saying the route layer and pipeline runner are excluded. That
   is now out of date: `backend/app.py` (routes) and `backend/real_runner.py`
   (runner) are both present.

4. **The security posture is deliberate and well-built.** Fail-closed secret
   encryption, an SSRF guard that re-checks redirect targets, path-traversal
   rejection on artifacts, a startup validator that refuses unsafe production
   config, and budget reservation to prevent concurrent overspend. This is not a
   codebase where security was bolted on.

---

## Where to start reading

- **To understand the product:** `backend/models.py` — the 15 tables and their
  documented invariants tell you what the system actually does.
- **To understand the API:** `backend/schemas.py`, then the route definitions in
  `app.py`.
- **To understand the interesting part:** `backend/real_runner.py`, alongside
  `backend/agents.py` for the prompts it uses.
- **To understand the constraints:** `backend/cost.py` and
  `backend/groundedness.py` — the two modules that exist to stop the system doing
  something expensive or untrue.
