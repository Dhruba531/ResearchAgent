"""P6: RunPod experiment execution + PaperBanana-style figure generation.

All offline: provider calls are replaced with isolated test doubles while the
production code remains provider-only.
"""
import asyncio
import os
import sys
from pathlib import Path

os.environ["AGENTLAB_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["AGENTLAB_DATA_DIR"] = "/tmp/agentlab-test-data"
os.environ["AGENTLAB_ARTIFACT_ROOT"] = "/tmp/agentlab-test-data/artifacts"

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cost  # noqa: E402
import images  # noqa: E402
import runner_common  # noqa: E402
import provider_adapters  # noqa: E402
import real_runner as rr  # noqa: E402
import runpod_adapter  # noqa: E402
from app import app  # noqa: E402
from database import SessionLocal  # noqa: E402
from runner_common import ConnectionManager  # noqa: E402
from models import AgentSession, Artifact, Brief, Project, ProviderKey, Run, User  # noqa: E402


# ---- cost caps ---------------------------------------------------------------
def test_gpu_pricing_and_caps():
    assert cost.gpu_price_per_hr("RTX 4090") == 1.116
    assert cost.gpu_price_per_hr("a100") == 2.736
    assert cost.gpu_price_per_hr("unknown") == cost._DEFAULT_GPU_PRICE_PER_HR
    # RunPod Serverless Flex 4090: $0.00031/s = $1.116/hr.
    assert cost.max_runtime_seconds(1.116, "rtx 4090") == 3600
    assert cost.max_runtime_seconds(0, "rtx 4090") == 0
    assert abs(cost.runpod_cost_usd("rtx 4090", 1800) - 0.558) < 1e-6
    assert cost.image_cost_usd("gemini") == 0.039
    assert cost.image_cost_usd("openai", 3) == 0.12


# ---- code extraction ---------------------------------------------------------
def test_extract_python_code():
    text = "Here is the plan.\n```python\nprint('hi')\n```\nand more\n```py\nx=1\n```"
    code = runpod_adapter.extract_python_code(text)
    assert "print('hi')" in code and "x=1" in code
    assert runpod_adapter.extract_python_code("no code here") == ""
    assert runpod_adapter.extract_python_code("```bash\nls\n```") == ""  # only python fences


def test_allow_execution_flag(monkeypatch):
    monkeypatch.delenv("AGENTLAB_ALLOW_EXECUTION", raising=False)
    assert runpod_adapter.allow_execution() is False
    monkeypatch.setenv("AGENTLAB_ALLOW_EXECUTION", "1")
    assert runpod_adapter.allow_execution() is True


def test_artifact_writers_reject_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_common, "ARTIFACT_ROOT", tmp_path / "artifacts")
    good = runner_common.write_artifact(7, "results.json", "{}")
    assert good == (tmp_path / "artifacts" / "run-7" / "results.json").resolve()
    assert good.read_text() == "{}"

    for bad in ("../escape.txt", "/tmp/escape.txt", r"..\escape.txt", "nested/file.txt", ""):
        with pytest.raises(ValueError):
            runner_common.write_artifact(7, bad, "x")
        with pytest.raises(ValueError):
            rr._write_bytes_artifact(7, bad, b"x")
    assert not (tmp_path / "escape.txt").exists()


def test_executor_no_code_and_unconfigured_provider():
    assert asyncio.run(runpod_adapter.run_experiment(code="   "))["status"] == "NO_CODE"
    result = asyncio.run(runpod_adapter.run_experiment(code="print(1)"))
    assert result["ok"] is False and result["status"] == "NOT_CONFIGURED"


def test_executor_cancellation_tears_down_remote_job(monkeypatch):
    import httpx

    calls = []

    class Response:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            pass

        def json(self):
            return self.body

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def post(self, url, **_kwargs):
            calls.append(("POST", url))
            return Response({"id": "job-1"})

        async def get(self, url, **_kwargs):
            calls.append(("GET", url))
            return Response({"status": "IN_PROGRESS"})

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)

    async def cancel_during_poll():
        task = asyncio.create_task(runpod_adapter.run_experiment(
            code="print(1)", api_key="rp", endpoint_id="ep",
            poll_interval=60.0, max_seconds=300,
        ))
        while not any(method == "GET" for method, _url in calls):
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_during_poll())
    assert any(method == "POST" and "/cancel/job-1" in url for method, url in calls)


# ---- figures -----------------------------------------------------------------
def test_figure_prompts_from_draft():
    draft = "## Results\nFigure 1: Accuracy vs cost.\nText.\nFigure 2: Ablation over context size.\n"
    prompts = images.figure_prompts_from_draft(draft, "My Study", limit=3)
    assert len(prompts) == 2 and "Accuracy vs cost" in prompts[0]
    # No figure lines -> falls back to a title-derived diagram prompt.
    assert len(images.figure_prompts_from_draft("no figures", "My Study")) == 1
    assert images.figure_prompts_from_draft("no figures", "") == []


def test_figure_generation_requires_provider_key():
    result = asyncio.run(images.generate_figure(prompt="a diagram", provider="openai", api_key=""))
    assert result["ok"] is False and "key is required" in result["error"]


# ---- real-path GATING (no network — capture the mode handed to the adapter) ---
def _seed_run(config_json, *, runpod=False, image=False):
    with SessionLocal() as db:
        user = User(name="Exec", email=f"exec-{os.urandom(3).hex()}@example.test", password_hash="")
        db.add(user)
        db.commit()
        db.add(ProviderKey(user_id=user.id, provider="anthropic", api_key="sk-ant-x", is_enabled=True))
        if runpod:
            db.add(ProviderKey(user_id=user.id, provider="runpod", api_key="rp-secret", model_name="ep_test", is_enabled=True))
        if image:
            db.add(ProviderKey(user_id=user.id, provider="openai", api_key="sk-image", is_enabled=True))
        project = Project(owner_id=user.id, title="Exec Project")
        db.add(project)
        db.commit()
        brief = Brief(project_id=project.id, version=1, content_json={"title": "Exec Study"}, is_approved=True)
        db.add(brief)
        db.commit()
        session = AgentSession(project_id=project.id, brief_id=brief.id, provider="anthropic")
        db.add(session)
        db.commit()
        run = Run(session_id=session.id, project_id=project.id, brief_id=brief.id,
                  config_json=config_json, cost_estimate=5.0, budget_threshold=50.0)
        db.add(run)
        db.commit()
        return run.id


def _fake_stream():
    async def fake(*, system, on_text=lambda _s: None, **kw):
        if "You are the Experiment Planner" in system:
            text = "## Methodology\n```python\nprint('experiment')\n```\n"
        elif "You are the Paper Assembler" in system:
            text = "# Draft\nFigure 1: Accuracy versus cost.\n"
        elif "You are the Editor agent" in system:
            text = "# Revised\nFigure 1: Accuracy versus cost.\n"
        elif "You are the Citation Verifier" in system:
            text = "## Verdict\nfine"
        elif "adversarial reviewer" in system:
            text = "## Score\n8/10"
        else:
            text = "content"
        on_text(text)
        return text, 40, 40
    return fake


def test_execution_and_figures_use_configured_providers(monkeypatch):
    monkeypatch.setenv("AGENTLAB_ALLOW_EXECUTION", "1")
    monkeypatch.setattr(provider_adapters, "stream_stage", _fake_stream())
    async def execute_double(**_kwargs):
        return {
            "ok": True,
            "mode": "real",
            "status": "COMPLETED",
            "exit_code": 0,
            "seconds": 1.0,
            "stdout": "measured=1.0",
            "stderr": "",
            "artifacts": [],
        }

    async def image_double(**_kwargs):
        return {"ok": True, "provider": "openai", "ext": "png", "data": b"PNG", "error": ""}

    monkeypatch.setattr(rr.runpod_adapter, "run_experiment", execute_double)
    monkeypatch.setattr(rr.images, "generate_figure", image_double)
    with TestClient(app):
        run_id = _seed_run({"execute": True, "figures": True}, runpod=True, image=True)
        asyncio.run(rr.RealAgentRunner(ConnectionManager())._run(run_id))
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            assert run.status == "completed"
            arts = {a.type for a in db.query(Artifact).filter(Artifact.run_id == run_id).all()}
            assert "experiment" in arts and "figure" in arts
            ex = run.analysis_json["execution"]
            assert ex and ex["status"] == "COMPLETED"
            assert ex["real"] is True
            assert len(run.analysis_json["figures"]) == 1


def test_addons_off_by_default(monkeypatch):
    monkeypatch.setattr(provider_adapters, "stream_stage", _fake_stream())
    with TestClient(app):
        run_id = _seed_run({}, runpod=True)  # no execute/figures flags
        asyncio.run(rr.RealAgentRunner(ConnectionManager())._run(run_id))
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            arts = {a.type for a in db.query(Artifact).filter(Artifact.run_id == run_id).all()}
            assert "experiment" not in arts and "figure" not in arts
            assert run.analysis_json["execution"] is None
            assert run.analysis_json["figures"] == []


def test_figure_generation_stops_before_exceeding_remaining_budget(monkeypatch):
    calls = {"n": 0}

    async def image_double(**_kwargs):
        calls["n"] += 1
        return {"ok": True, "provider": "openai", "ext": "png", "data": b"PNG", "error": ""}

    monkeypatch.setattr(rr.images, "generate_figure", image_double)
    with TestClient(app):
        run_id = _seed_run({"figures": True}, image=True)
        runner = rr.RealAgentRunner(ConnectionManager())
        ctx = {"draft": "# Paper without an explicit figure caption", "title": "Budgeted figure"}
        stopped = asyncio.run(runner._run_figures(
            run_id,
            "gpt-4o",
            ctx,
            {"input": 0, "output": 0},
            {
                "image_provider": "openai",
                "image_key": "sk-test",
                "budget_threshold": 0.03,
                "monthly_remaining": 50.0,
                "prior_cost_usd": 0.0,
                "addon_cost_usd": 0.0,
            },
        ))
        assert stopped is False
        assert calls["n"] == 0
        assert ctx["figures"] == []
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            run.status = run.session.status = "failed"
            db.commit()


def test_gpu_execution_requires_operator_flag(monkeypatch):
    """No local/synthetic execution occurs when the operator flag is off."""
    captured = {"calls": 0}

    async def capture(**kwargs):
        captured["calls"] += 1
        assert "mode" not in kwargs
        return {"ok": True, "mode": "real", "status": "COMPLETED", "exit_code": 0,
                "seconds": 1.0, "stdout": "ok", "stderr": "", "artifacts": []}

    monkeypatch.setattr(provider_adapters, "stream_stage", _fake_stream())
    monkeypatch.setattr(rr.runpod_adapter, "run_experiment", capture)

    monkeypatch.setenv("AGENTLAB_ALLOW_EXECUTION", "1")
    with TestClient(app):
        run_id = _seed_run({"execute": True}, runpod=True)
        asyncio.run(rr.RealAgentRunner(ConnectionManager())._run(run_id))
    assert captured["calls"] == 1

    captured["calls"] = 0
    monkeypatch.delenv("AGENTLAB_ALLOW_EXECUTION", raising=False)
    with TestClient(app):
        run_id = _seed_run({"execute": True}, runpod=True)
        asyncio.run(rr.RealAgentRunner(ConnectionManager())._run(run_id))
    assert captured["calls"] == 0
