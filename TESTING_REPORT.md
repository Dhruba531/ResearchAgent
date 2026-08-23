# Testing Report — ResearchAgent

**Repository:** `Dhruba531/ResearchAgent`
**Commit under test:** `c0e0336`
**Date:** 2026-08-23

Three types of testing were applied: **unit testing**, **white-box testing**
(coverage measurement), and **static code analysis** — across both the Python
backend (31 files, 13,222 lines) and the TypeScript frontend (97 files).

---

## 1. Summary

| Testing type | Tooling | Result |
|---|---|---|
| Unit testing | pytest 8 | **127 tests: 104 passed, 23 failed** in the full run |
| Unit testing (per-file) | pytest 8 | **9 of 10 files pass 100% in isolation** |
| White-box testing | coverage.py | **71.6% statement, 53.4% branch** (591/1,106 branches) |
| Static analysis — Python | Ruff 0.16, Bandit, pip-audit | 726 lint items, **0 high-severity security findings** |
| Static analysis — TypeScript | tsc 5.9, ESLint 9 | **0 type errors**, 692 formatting errors, 30 warnings |

**Headline result: none of the 23 test failures is a product defect.** All 23 are
defects in the *test suite's design* — 12 from cross-test pollution, 11 from a
hard dependency on live third-party credentials. Both are diagnosed in §3.

---

## 2. Unit testing

The repository already contains a pytest suite: **10 files, 2,801 lines, 127
tests**, organised by the phase of work that introduced each group.

### Environment

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.in pytest pytest-cov
.venv/bin/python -m pytest backend/tests -q
```

Python 3.11.15. The tests need no fixture setup of their own — each file sets
`AGENTLAB_DATABASE_URL=sqlite:///:memory:` at import time and inserts the backend
directory onto `sys.path`. There is no `conftest.py` and no pytest configuration
file.

### Full-suite result

```
23 failed, 104 passed in 4.50s
```

### Per-file result

Running each file as its own pytest process gives a very different picture:

| File | Result |
|---|---|
| `test_p10_recovery_readiness.py` | 9 passed |
| `test_p13_campaigns.py` | 17 passed |
| `test_p14_bugfixes.py` | 10 passed |
| `test_p15_research_swarm.py` | 19 passed |
| `test_p17_concurrent_failure_and_cost.py` | 9 passed |
| **`test_p2_hardening.py`** | **12 failed, 12 passed** |
| `test_p3_production.py` | 6 passed |
| `test_p4_agentic.py` | 10 passed |
| `test_p6_execution_figures.py` | 12 passed |
| `test_p7_groundedness.py` | 11 passed |

Nine of ten files pass completely on their own. That gap — 23 failures together,
12 apart — is itself the most important finding in this report.

---

## 3. Failure analysis

### 3.1 Twelve failures are cross-test pollution (defect #1)

`test_p14_bugfixes.py` (10 tests) and `test_p7_groundedness.py` (11 tests) pass
**100% in isolation** and fail in the full run. Nothing about those tests or the
code they exercise changed — only what ran before them.

The mechanism is visible in the captured logs: requests that should return `200`
come back **`429 Too Many Requests`**. `backend/ratelimit.py` implements a
fixed-window limiter whose counters are **module-level state**, shared by every
test in the process. Once earlier files exhaust the auth window, later files
cannot register the users their fixtures depend on, and their assertions fail on
the fallout rather than on anything they were written to check.

The same mechanism operates *within* a file:
`test_p2_hardening.py::test_login_is_rate_limited` asserts `401` and receives
`429`. Run alone, it passes.

**Impact: high for CI reliability.** The suite is order-dependent, so its result
depends on collection order rather than on the correctness of the code. A green
run is not currently evidence that the code is sound, and a red one is not
evidence that it is broken.

**Fix:** `backend/ratelimit.py` already exports a `reset()` function. An
autouse fixture in a `conftest.py` calling it between tests would resolve this:

```python
# backend/tests/conftest.py
import pytest, ratelimit

@pytest.fixture(autouse=True)
def _reset_rate_limits():
    ratelimit.reset()
    yield
```

### 3.2 Eleven failures require live provider credentials (defect #2)

Every remaining failure is in `test_p2_hardening.py` and dies at the same place —
line 46, inside the shared helper `project_with_approved_brief`:

```
assert client.post(f"/api/briefs/{brief['id']}/approve", ...).status_code == 200
E   KeyError: 'id'
```

The `KeyError` is a symptom, not the cause. The preceding call to
`POST /api/projects/{id}/briefs/generate` returned **502**, so there was no
brief to approve. The captured log gives the real reason:

```
WARNING agentlab.brief: Brief generation failed for project 1: AuthenticationError
INFO    request POST /api/projects/1/briefs/generate status 502 duration_ms 645.5
```

Brief generation made a **real outbound HTTPS call to a live LLM provider** and
was rejected because the test's provider key is a fixture value. The 645 ms
duration confirms a genuine network round-trip.

I searched the backend for a mock, offline, or fixture mode
(`mock|offline|fake_provider|AGENTLAB_TEST`) and **found none**. There is no
supported way to exercise these paths without real Anthropic or OpenAI
credentials.

**Impact: medium.** These 11 tests cannot pass in any CI environment without
provisioning live API secrets, and running them spends real credits. They are
integration tests filed alongside unit tests, with nothing marking the
difference.

**Fix:** mark them (`@pytest.mark.integration`) and deselect by default, and/or
introduce a stub provider adapter so the governance logic under test — which is
about gates and budgets, not about model output — can be tested without a network
call.

---

## 4. White-box testing (coverage)

Measured with `coverage.py` via `pytest-cov`, branch coverage enabled, running
each file in isolation and appending, so the pollution in §3.1 does not suppress
the numbers.

```bash
for f in backend/tests/test_*.py; do
  .venv/bin/python -m pytest "$f" -q --cov=backend --cov-branch --cov-append --cov-report=
done
```

| Module | Statements | Stmt cov | Branch cov |
|---|---|---|---|
| `models.py` | 220 | **100.0%** | n/a |
| `schemas.py` | 339 | 95.1% | 30.0% |
| `agents.py` | 80 | 95.8% | 81.2% |
| `cost.py` | 164 | 94.2% | 93.5% |
| `groundedness.py` | 136 | 88.9% | 81.8% |
| `database.py` | 35 | 87.2% | 50.0% |
| `ratelimit.py` | 42 | 80.0% | 50.0% |
| `runner_common.py` | 42 | 80.0% | 75.0% |
| `observability.py` | 129 | 77.3% | 67.6% |
| `real_runner.py` | 937 | 70.9% | 63.4% |
| `runpod_adapter.py` | 89 | 68.5% | 63.6% |
| `crypto.py` | 60 | 62.2% | 54.5% |
| `auth.py` | 81 | 61.5% | 35.7% |
| `app.py` | 1,131 | 56.9% | 45.5% |
| `images.py` | 56 | 47.4% | 35.0% |
| `vector_store.py` | 101 | 30.1% | 13.6% |
| `provider_adapters.py` | 91 | 29.8% | 10.0% |
| `supabase_auth.py` | 132 | **15.3%** | **1.7%** |
| **TOTAL** | **3,865** | **71.6%** | **53.4%** |

For comparison, the same measurement over the polluted full-suite run yields
67.8% statement coverage — the ordering defect costs roughly 3.8 points of
measured coverage on top of the false failures.

### Where the gaps are, and which ones matter

The coverage profile is uneven in a way that maps directly onto §3.2. The three
weakest modules are the ones that talk to external services:

- **`supabase_auth.py` — 15.3% statement, 1.7% branch.** The weakest module in
  the codebase, and it is **JWT verification**: HS256 and rotating RS256/ES256 via
  JWKS, plus first-login user provisioning. Authentication logic at 1.7% branch
  coverage is the single highest-risk gap here. Token verification is also
  eminently unit-testable offline — a signed test token needs no network — so this
  gap is not forced by the constraint in §3.2.
- **`provider_adapters.py` — 29.8% / 10.0%.** Uncovered because exercising it
  means calling a real provider (§3.2).
- **`vector_store.py` — 30.1% / 13.6%.** A no-op without a configured pgvector
  database, so most branches are unreachable in this environment. Low risk.

Conversely, the governance core is well covered: `models.py` at 100%, `cost.py`
at 93.5% branch, `groundedness.py` at 81.8% branch. **The parts of the system
that enforce human gates, spend limits, and anti-hallucination checks are the
best-tested parts of it** — the right priority.

`app.py` at 45.5% branch is the largest absolute gap (1,131 statements), but it
is mostly route wiring; its logic lives in the modules above.

---

## 5. Static code analysis

### 5.1 Python — Ruff

Ruff 0.16.4 with an explicit, reproducible rule selection:

```bash
.venv/bin/ruff check backend/ app.py --select E,F,B,S,BLE,DTZ,TRY,RUF --ignore B008,E501
```

`B008` is excluded because it flags FastAPI's `Depends()` idiom, which is correct
usage in this framework; `E501` (line length) is excluded as pure style.

**726 items.** Ranked by what actually matters:

| Rule | Count | Assessment |
|---|---|---|
| `S101` assert | 357 | **Noise** — pytest assertions, correct usage |
| `E402` import-not-at-top | 177 | **Intentional** — tests set env vars before importing; already carry `# noqa: E402` |
| `TRY003` vanilla exception args | 74 | Style |
| **`BLE001` blind except** | **34** | **Genuine** — see below |
| `S108` hardcoded temp file | 21 | Mostly test `/tmp` paths |
| `S608` hardcoded SQL | 16 | **False positive** — see below |
| `B904` raise-without-from | 9 | Minor — loses exception context in tracebacks |
| `F841` unused variable | 5 | Dead code |
| `F401` unused import | 4 | Dead code |
| `DTZ003` naive `utcnow()` | 4 | Worth fixing — timezone-naive timestamps |

**The 34 blind `except` handlers are the finding worth acting on.** A bare
`except Exception:` swallows failures indiscriminately — including the
`AuthenticationError` in §3.2, which surfaced only as a generic 502. Each should
catch the specific exception it expects.

**The 16 SQL-injection warnings are false positives.** All are in
`backend/migrations/versions/0004_remove_legacy_demo_account.py`, where f-strings
compose *static* SQL fragments:

```python
projects = "SELECT p.id FROM projects p JOIN users u ON u.id = p.owner_id WHERE u.email = :email"
runs = f"SELECT id FROM runs WHERE project_id IN ({projects})"
```

Nothing user-controlled is interpolated; the one variable, `email`, is correctly
passed as the bound parameter `:email`. Not exploitable. Worth a `# noqa: S608`
with a comment so future scans stay quiet.

### 5.2 Python — Bandit

```bash
.venv/bin/bandit -r backend/ app.py -x backend/tests
```

**16 issues, all MEDIUM, all `B608` — the same migration-file false positives
above. Zero HIGH-severity findings.**

That is a genuinely good result for a codebase handling encrypted secrets, JWT
verification, outbound URL fetching, and remote code execution. It is consistent
with what the source shows: fail-closed secret encryption in `crypto.py`, an SSRF
guard in `groundedness.py` that re-validates redirect targets, path-traversal
rejection in `runner_common.py`, and a startup validator that refuses to boot on
unsafe production configuration.

### 5.3 Python — dependency audit

```bash
.venv/bin/pip-audit
```

One package flagged: **`setuptools` 79.0.1 — PYSEC-2026-3447**, fixed in 83.0.0.

**Context matters here: `setuptools` is not a declared dependency.** It is not in
`backend/requirements.in`; it arrives as part of the virtualenv toolchain. The
project's own declared dependencies are clean. `requirements.in` also already
carries deliberate version floors for transitive packages flagged by a previous
audit, which suggests this is being tracked.

### 5.4 TypeScript

```bash
npx tsc --noEmit   # 0 errors
npx eslint .
```

**`tsc` is completely clean — 0 type errors.**

ESLint: **692 errors, 30 warnings.**

| Rule | Count | Severity | Assessment |
|---|---|---|---|
| `prettier/prettier` | 692 | error | Formatting only |
| `react-refresh/only-export-components` | 25 | warning | Dev-only hot-reload hint |
| **`react-hooks/exhaustive-deps`** | **4** | warning | **Genuine bug risk** |
| Unused `eslint-disable` directive | 1 | warning | Dead suppression |

As on the Python side, the volume is misleading: 692 of 722 items are formatting,
which buries the 30 substantive warnings. `npm run format` clears them
mechanically.

**The four hook-dependency warnings are real.** An incomplete dependency array
makes a `useEffect` or `useMemo` read stale values after a re-render — an
intermittent class of bug that manual testing rarely reproduces:

| Location | Missing dependency |
|---|---|
| `src/components/console/gates.tsx:208` | `brief?.content_markdown` |
| `src/components/console/setup.tsx:153` | `project` |
| `src/components/console/timeline.tsx:445` | `preRunGates`, `runGates` |
| `src/routes/console.tsx:425` | `activeId`, `activeRun` |

Each needs individual review — some omissions are deliberate, to prevent a
re-render loop, and those should carry an explanatory `eslint-disable` comment.

---

## 6. Defect register

| # | Finding | Type | Severity | Evidence |
|---|---|---|---|---|
| 1 | Test suite is order-dependent — 12 tests pass alone, fail together (shared rate-limiter state) | Test design | **High** | §3.1 |
| 2 | 11 tests require live provider API credentials; no mock/offline mode exists | Test design | **Medium** | §3.2 |
| 3 | `supabase_auth.py` (JWT verification) at 15.3% statement / 1.7% branch coverage | Coverage | **Medium** | §4 |
| 4 | 4 × incomplete React hook dependency arrays | Static analysis | **Medium** | §5.4 |
| 5 | 34 blind `except` handlers masking specific failures | Static analysis | Medium | §5.1 |
| 6 | `app.py` and `backend/app.py` are byte-identical 2,392-line duplicates | Structure | Medium | MD5 `121a9ef2…` |
| 7 | 4 × timezone-naive `datetime.utcnow()` calls | Static analysis | Low | §5.1 |
| 8 | Dead code: 5 unused variables, 4 unused imports | Static analysis | Low | §5.1 |
| 9 | 692 Prettier violations obscuring 30 real warnings | Static analysis | Low | §5.4 |
| 10 | `setuptools` PYSEC-2026-3447 in the resolved environment | Dependencies | Low | §5.3 — not a declared dependency |

### Not defects

- **16 Bandit/Ruff "SQL injection" findings** — static SQL in a migration, no
  user input interpolated. Suppress with a comment rather than refactor.
- **357 `assert` warnings** — pytest assertions.
- **177 import-position warnings** — deliberate, already annotated.

---

## 7. Recommendations, in priority order

1. **Add `backend/tests/conftest.py` with an autouse `ratelimit.reset()`
   fixture.** Highest value for the least work: it makes the suite's result
   trustworthy, which every other testing effort depends on.
2. **Separate integration tests from unit tests.** Mark the 11 credential-dependent
   tests and deselect them by default, or add a stub provider adapter.
3. **Raise `supabase_auth.py` coverage.** JWT verification at 1.7% branch coverage
   is the riskiest gap, and it is testable offline with locally signed tokens.
4. **Review the 4 hook-dependency warnings individually.**
5. **Collapse the duplicated `app.py`** into a single module before the two copies
   drift.
6. **Replace the 34 blind excepts** with specific exception types.
7. **Run `npm run format` as a standalone commit** so future lint output shows
   substantive findings only.
8. **Add CI** running `pytest` and `tsc --noEmit` — both are meaningful gates
   today, once item 1 lands.

---

## 8. Reproducing this report

```bash
# Python
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.in pytest pytest-cov ruff bandit pip-audit
.venv/bin/python -m pytest backend/tests -q                      # 104 passed, 23 failed
for f in backend/tests/test_*.py; do .venv/bin/python -m pytest "$f" -q; done   # 9/10 files clean
.venv/bin/python -m pytest backend/tests --cov=backend --cov-branch
.venv/bin/ruff check backend/ app.py --select E,F,B,S,BLE,DTZ,TRY,RUF --ignore B008,E501
.venv/bin/bandit -r backend/ app.py -x backend/tests
.venv/bin/pip-audit

# TypeScript
npm install
npx tsc --noEmit                                                  # 0 errors
npx eslint .
```

No source file was modified in the course of this testing. Every finding is a
pre-existing condition, reported rather than silently repaired.
