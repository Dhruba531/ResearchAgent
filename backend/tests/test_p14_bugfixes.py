"""Regression tests for the review findings.

Each test pins a specific defect that the suite previously did not cover, so a
reintroduction fails here rather than in production.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("AGENTLAB_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("AGENTLAB_DATA_DIR", "/tmp/agentlab-test-data")
os.environ.setdefault("AGENTLAB_ARTIFACT_ROOT", "/tmp/agentlab-test-data/artifacts")
os.environ["AGENTLAB_VERIFY_URLS"] = "0"

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from fastapi.testclient import TestClient  # noqa: E402

import agents  # noqa: E402
import app as app_module  # noqa: E402
import cost  # noqa: E402
import real_runner  # noqa: E402
from database import ARTIFACT_ROOT, SessionLocal, init_db  # noqa: E402
from models import Brief, Campaign, Candidate, Project, User  # noqa: E402

init_db()

MODEL = "claude-opus-4-8"


def _register(client: TestClient, tag: str) -> int:
    email = f"{tag}-{os.urandom(4).hex()}@example.test"
    assert client.post(
        "/api/auth/register", json={"name": tag, "email": email, "password": "strong-pass-123"}
    ).status_code == 200
    with SessionLocal() as db:
        return db.query(User).filter(User.email == email).one().id


def _project(owner_id: int) -> int:
    with SessionLocal() as db:
        project = Project(owner_id=owner_id, title="Bugfix project")
        db.add(project)
        db.commit()
        db.add(Brief(project_id=project.id, version=1, is_approved=True))
        db.commit()
        return project.id


def _campaign(client: TestClient, project_id: int, **extra) -> dict:
    body = {"budget": {"max_iters": 20, "usd": 25.0}, **extra}
    response = client.post(f"/api/projects/{project_id}/campaigns", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _candidate(campaign_id: int, iteration: int, **kwargs) -> int:
    with SessionLocal() as db:
        row = Candidate(campaign_id=campaign_id, iteration=iteration, **kwargs)
        db.add(row)
        db.commit()
        return row.id


# ---------------------------------------------------------------------------
# #1 — gate-2 budget must cover the refinement loop it will actually run
# ---------------------------------------------------------------------------
def test_estimate_scales_with_revise_iterations():
    """The approved ceiling must cover every round the runner will execute."""
    one, _, _ = cost.estimate_real_run(MODEL, revise_iterations=1)
    three, _, assumptions = cost.estimate_real_run(MODEL, revise_iterations=3)
    five, _, _ = cost.estimate_real_run(MODEL, revise_iterations=5)

    assert three > one, "extra refinement rounds must raise the estimate"
    assert five > three
    # Each extra round costs a full reviewer panel plus one editor revision.
    per_round = len(agents.REVIEWERS) + 1
    assert f"{10 + 2 * per_round} model calls" in assumptions[0]
    assert any("refinement rounds" in a for a in assumptions)


def test_estimate_endpoint_defaults_to_the_runner_iteration_count():
    """A run that omits revise_iterations still gets the runner's real default."""
    explicit, _, _ = cost.estimate_real_run(MODEL, revise_iterations=real_runner.MAX_REVISE_ITERS)
    default_from_api = app_module.cost.estimate_real_run(
        MODEL,
        revise_iterations=max(
            1,
            min(
                app_module.REVISE_ITERS_HARD_CAP,
                int({}.get("revise_iterations", app_module.MAX_REVISE_ITERS)),
            ),
        ),
    )[0]
    assert default_from_api == explicit
    # Regression guard: the old code estimated a single round.
    single, _, _ = cost.estimate_real_run(MODEL, revise_iterations=1)
    assert default_from_api > single


# ---------------------------------------------------------------------------
# #4 — an unscored round must not displace a scored best
# ---------------------------------------------------------------------------
def test_unscored_review_round_never_overwrites_a_scored_best():
    """Reproduces the loop's selection rule directly.

    An unparseable panel gives no evidence the version is better, so it must not
    displace a *measured* best — that was the path by which a regression could
    ship. While nothing has scored there is no measured best to protect, so the
    newest revision is still tracked rather than discarding the whole loop.
    """
    def select(rounds):
        best_paper, best_reviews, best_score = "original", None, None
        for paper, score in rounds:
            reviews = {"methods": f"score {score}"}
            if score is not None:
                if best_score is None or score > best_score:
                    best_score, best_paper, best_reviews = score, paper, reviews
            elif best_score is None:
                best_paper, best_reviews = paper, reviews
        return best_paper, best_score

    # The defect: a measured winner must survive later unscored rounds.
    assert select([("good", 9.0), ("mystery", None), ("other", None)]) == ("good", 9.0)
    # A genuine improvement still wins.
    assert select([("good", 7.0), ("better", 8.5)]) == ("better", 8.5)
    # A measured regression never displaces the measured best.
    assert select([("good", 9.0), ("worse", 4.0)]) == ("good", 9.0)
    # Nothing measured anywhere: keep the newest version, not the original, so
    # the refinement rounds the run paid for are not thrown away.
    assert select([("rev1", None), ("rev2", None)]) == ("rev2", None)
    # A score appearing later still takes over from the unscored placeholder.
    assert select([("rev1", None), ("scored", 6.0)]) == ("scored", 6.0)


# ---------------------------------------------------------------------------
# #6 — rejecting a candidate must not destroy the agent's interpretation
# ---------------------------------------------------------------------------
def test_reject_preserves_agent_interpretation():
    with TestClient(app_module.app) as client:
        owner = _register(client, "keepnotes")
        campaign = _campaign(client, _project(owner))
        candidate_id = _candidate(
            campaign["id"], 0, score=5.0, status="kept",
            notes_json={"hypothesis": "wider MLP helps", "interpretation": "throughput fell 12%"},
        )

        body = client.post(
            f"/api/candidates/{candidate_id}/reject", json={"reason": "Inside noise."}
        ).json()

        # The human's verdict is recorded separately from the agent's analysis.
        assert body["notes"]["rejection_reason"] == "Inside noise."
        assert body["notes"]["interpretation"] == "throughput fell 12%"
        assert body["notes"]["hypothesis"] == "wider MLP helps"


def test_useful_regression_rate_is_not_pinned_by_rejections():
    """Overwriting interpretation on reject used to force this metric to 1.0."""
    with TestClient(app_module.app) as client:
        owner = _register(client, "regrate")
        campaign = _campaign(client, _project(owner))
        cid = campaign["id"]
        no_note = _candidate(cid, 0, score=1.0, status="kept")
        rejected = _candidate(cid, 1, score=0.5, status="running")
        client.post(f"/api/candidates/{rejected}/reject", json={"reason": "no signal"})

        metrics = client.get(f"/api/campaigns/{cid}").json()["metrics"]
        # One discarded candidate with no agent interpretation → rate 0.0, not 1.0.
        assert metrics["useful_regression_rate"] == 0.0
        assert no_note  # silence lint on the unused fixture id


# ---------------------------------------------------------------------------
# #7 — a lower-is-better campaign must be declarable and ranked correctly
# ---------------------------------------------------------------------------
def test_lower_is_better_is_declarable_and_ranks_consistently():
    """Validation BPB is lower-is-better; it must be settable through the API."""
    with TestClient(app_module.app) as client:
        owner = _register(client, "bpb")
        campaign = _campaign(
            client, _project(owner), metric="val_bpb", lower_is_better=True, cost_metric="gpu_hours"
        )
        cid = campaign["id"]
        assert campaign["config"]["lower_is_better"] is True
        assert campaign["config"]["metric"] == "val_bpb"

        best = _candidate(cid, 0, score=0.98, status="kept", cost_vector_json={"gpu_hours": 1.0})
        worst = _candidate(cid, 1, score=1.40, status="kept", cost_vector_json={"gpu_hours": 2.0})

        # Leaderboard: lowest BPB first.
        board = client.get(f"/api/campaigns/{cid}/leaderboard").json()
        assert [r["candidate_id"] for r in board] == [best, worst]

        # The candidate list must agree with the leaderboard, not invert it.
        listed = client.get(f"/api/campaigns/{cid}/candidates?sort=score").json()
        assert [c["id"] for c in listed] == [best, worst]

        # Frontier: the cheap low-BPB candidate dominates the expensive high one.
        points = {p["candidate_id"]: p for p in client.get(f"/api/campaigns/{cid}/frontier").json()}
        assert points[best]["dominated"] is False
        assert points[worst]["dominated"] is True
        assert points[best]["cost_label"] == "gpu_hours"
        assert points[best]["quality_label"] == "val_bpb"


def test_higher_is_better_remains_the_default():
    with TestClient(app_module.app) as client:
        owner = _register(client, "defaultdir")
        campaign = _campaign(client, _project(owner))
        cid = campaign["id"]
        low = _candidate(cid, 0, score=2.0, status="kept")
        high = _candidate(cid, 1, score=9.0, status="kept")
        assert [r["candidate_id"] for r in client.get(f"/api/campaigns/{cid}/leaderboard").json()] == [high, low]
        assert [c["id"] for c in client.get(f"/api/campaigns/{cid}/candidates?sort=score").json()] == [high, low]


# ---------------------------------------------------------------------------
# #8 — stagnation must be derived, not read from a stale counter
# ---------------------------------------------------------------------------
def test_stagnation_counter_is_derived_from_the_archive():
    with TestClient(app_module.app) as client:
        owner = _register(client, "stagnation")
        campaign = _campaign(client, _project(owner))
        cid = campaign["id"]
        best = _candidate(cid, 2, score=9.0, status="kept")
        _candidate(cid, 7, score=3.0, status="discarded")
        with SessionLocal() as db:
            row = db.get(Campaign, cid)
            row.iteration = 7
            row.best_candidate_id = best
            row.best_score = 9.0
            # A stale cached counter must not win over the computed value.
            row.metrics_json = {"stagnation_counter": 0}
            db.commit()

        metrics = client.get(f"/api/campaigns/{cid}").json()["metrics"]
        assert metrics["stagnation_counter"] == 5  # iteration 7 − best at 2


# ---------------------------------------------------------------------------
# #9 — an explicit trace_dir must be honoured, and still contained
# ---------------------------------------------------------------------------
def test_explicit_trace_dir_is_used_when_set():
    with TestClient(app_module.app) as client:
        owner = _register(client, "tracedir")
        campaign = _campaign(client, _project(owner))
        relative = f"custom-archive/{os.urandom(3).hex()}"
        candidate_id = _candidate(campaign["id"], 0, score=1.0, trace_dir=relative)

        target = (ARTIFACT_ROOT / relative).resolve()
        target.mkdir(parents=True, exist_ok=True)
        (target / "stdout.log").write_text("from the custom archive", encoding="utf-8")

        trace = client.get(f"/api/candidates/{candidate_id}/trace").json()
        assert trace["stdout"] == "from the custom archive"


def test_trace_dir_escaping_the_artifact_root_is_ignored():
    """A stored path must never become an arbitrary-file-read primitive."""
    with TestClient(app_module.app) as client:
        owner = _register(client, "traceescape")
        campaign = _campaign(client, _project(owner))
        candidate_id = _candidate(campaign["id"], 0, score=1.0, trace_dir="/etc")

        # Falls back to the derived (empty) location rather than reading /etc.
        trace = client.get(f"/api/candidates/{candidate_id}/trace").json()
        assert trace["stdout"] == ""
        assert trace["tree"] == []

        leak = client.get(
            f"/api/candidates/{candidate_id}/trace/file", params={"path": "passwd"}
        )
        assert leak.status_code == 404
