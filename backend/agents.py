"""
AgentLab — agent definitions.

Each "stage" in the research pipeline is an AI agent with its own persona
(system prompt) and a user prompt built from the prior stages' outputs.

The pipeline:

    idea ─▶ Brief Builder ─▶ Experiment Planner ─▶ Paper Assembler
                                                        │
                                                        ▼
                                            Citation Verifier  ← web search
                                                        │
                                                        ▼
                                            Reviewer Panel (4 agents)
                                                        │
                                                  [ human gate ]
                                                        │
                                                        ▼
                                                 Editor → Final draft

Several stages are given a provider-hosted **web search** tool so the agents can
ground their work in real sources instead of inventing them: the Planner finds
real datasets/baselines, the Assembler writes a real Related Work section, the
Citation Verifier checks every reference actually exists, and the Editor fills
any remaining gaps. The Novelty reviewer can also search to check prior art.

This module only builds prompts and tool configs — it never touches the network
or the API key. The backend adapts the resulting (system, user, max_tokens,
tools) tuple to the selected provider.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Reviewer personas for the panel stage.
# ---------------------------------------------------------------------------
REVIEWERS: Dict[str, Dict[str, str]] = {
    "methods": {
        "name": "Methods Reviewer",
        "focus": (
            "experimental design, validity, reproducibility, confounds, "
            "baselines, ablations, and whether the method actually tests the "
            "stated hypotheses"
        ),
    },
    "statistics": {
        "name": "Statistics Reviewer",
        "focus": (
            "sample sizes, statistical power, significance testing, multiple "
            "comparisons, error bars / confidence intervals, and whether the "
            "claimed effects are supported by the numbers"
        ),
    },
    "novelty": {
        "name": "Novelty Reviewer",
        "focus": (
            "prior work, originality, the size of the contribution, and "
            "whether the paper meaningfully advances beyond existing methods"
        ),
    },
    "clarity": {
        "name": "Clarity Reviewer",
        "focus": (
            "structure, readability, notation, figure/table usefulness, and "
            "whether a competent reader could understand and reproduce the work"
        ),
    },
}

# How many output tokens each stage is allowed. Streaming is always on, so
# these can be generous without risking an HTTP timeout.
MAX_TOKENS: Dict[str, int] = {
    "brief": 6000,
    "plan": 10000,
    "draft": 20000,
    "verify": 9000,
    "review": 4000,
    "revise": 20000,
    "orchestrate": 300,  # a routing decision, not content
    "advise": 1800,      # board-level critique, never worker execution
    "delegate": 1500,    # a decomposition plan, not content
    "investigate": 6000,  # one worker's evidence report
    "synthesize": 12000,  # merged evidence base feeding the draft
}

# Per-stage web-search budget (max number of searches the model may run in that
# stage). Stages not listed get no search tool at all. Keeping these bounded
# matters because every search is billed on the user's key.
SEARCH_BUDGET: Dict[str, int] = {
    "plan": 4,     # find real datasets, benchmarks, baselines
    "draft": 6,    # real Related Work + real citations
    "verify": 10,  # the dedicated fact/citation checker — needs the most
    "review": 4,   # only used by the Novelty reviewer (see _web_search_tools)
    "revise": 5,   # fill any citation gaps the verifier left open
    # Swarm workers are the evidence gatherers, so each gets a real search
    # budget — but this is per worker and workers run in parallel, so the true
    # spend is this number times the fan-out. Kept deliberately modest.
    "investigate": 8,
    # "delegate" and "synthesize" are reasoning stages over text the swarm
    # already has; giving them search would duplicate the workers' job.
}


def _web_search_tools(stage: str, ctx: Dict) -> Optional[List[Dict]]:
    """Return the web-search tool config for a stage, or None for no search.

    The reviewer panel only gets search for the Novelty reviewer — the other
    three (methods/statistics/clarity) judge the text in front of them and don't
    need to hit the network.
    """
    if stage == "review" and (ctx or {}).get("reviewer") != "novelty":
        return None
    budget = SEARCH_BUDGET.get(stage)
    if not budget:
        return None
    return [{"type": "web_search_20250305", "name": "web_search", "max_uses": budget}]


def _brief(ctx: Dict) -> Tuple[str, str]:
    system = (
        "You are the Brief Builder agent in AgentLab, a platform that helps "
        "researchers run real experiments with AI agents. Your job is to turn "
        "a rough, possibly half-formed research idea into a sharp, structured "
        "research brief that the downstream planning and writing agents can act "
        "on. Be rigorous and concrete. Do not invent results. If the idea is "
        "vague, make reasonable, clearly-labelled assumptions rather than "
        "asking questions.\n\n"
        "Return Markdown with these sections, in order:\n"
        "## Title  (a concise working title)\n"
        "## Problem & Motivation  (what's the gap, why it matters)\n"
        "## Research Questions  (2-4 precise, answerable questions)\n"
        "## Hypotheses  (testable predictions)\n"
        "## Scope & Assumptions  (what's in, what's out, stated assumptions)\n"
        "## Success Criteria  (how we'll know the work succeeded)"
    )
    user = (
        "Here is the researcher's raw idea. Turn it into a research brief.\n\n"
        "<idea>\n" + ctx.get("idea", "").strip() + "\n</idea>"
    )
    return system, user


def _plan(ctx: Dict) -> Tuple[str, str]:
    system = (
        "You are the Experiment Planner agent in AgentLab. Given a research "
        "brief, design a concrete, cost-aware experimental plan that an AI "
        "coding agent could actually execute on a cloud machine with optional "
        "GPU access. Be specific about datasets, baselines, and metrics. Give "
        "realistic, clearly-labelled estimates; never present guesses as "
        "facts.\n\n"
        "You have a web_search tool. Use it to name *real* datasets, "
        "benchmarks, and baseline methods that exist, and to sanity-check that "
        "your proposed setup matches how the field actually evaluates this kind "
        "of work. Prefer concrete, searchable names (e.g. real benchmark and "
        "model names) over generic placeholders.\n\n"
        "Return Markdown with these sections:\n"
        "## Methodology  (the approach, step by step)\n"
        "## Datasets & Resources  (named datasets/benchmarks, or how to build them)\n"
        "## Baselines  (what we compare against)\n"
        "## Experiments  (a numbered list; each = setup, variable, expected signal)\n"
        "## Metrics  (how each experiment is measured)\n"
        "## Compute & Cost Estimate  (rough hardware, runtime, and $ — labelled as estimates)\n"
        "## Risks & Mitigations  (what could go wrong, and the fallback)"
    )
    user = (
        "Design an experimental plan for this brief.\n\n"
        "<brief>\n" + ctx.get("brief", "").strip() + "\n</brief>"
    )
    return system, user


def _draft(ctx: Dict) -> Tuple[str, str]:
    system = (
        "You are the Paper Assembler agent in AgentLab. Using the research "
        "brief and the experiment plan, write a complete first draft of a "
        "research paper in Markdown. This is a *draft to be reviewed*, so it "
        "must be honest: clearly distinguish proposed/expected results from "
        "demonstrated ones, and never fabricate numbers or citations.\n\n"
        "You have a web_search tool. Use it to write a Related Work section "
        "grounded in real papers and to support factual claims with real "
        "sources. When you cite something you found, give the author/venue/year "
        "and keep the URL so it can be checked. Only when you genuinely cannot "
        "find a source, fall back to a clearly-marked placeholder like "
        "[CITATION NEEDED: topic]. Never invent a citation.\n\n"
        "Use this structure:\n"
        "# Title\n"
        "## Abstract\n"
        "## 1. Introduction\n"
        "## 2. Related Work\n"
        "## 3. Method\n"
        "## 4. Experimental Setup\n"
        "## 5. Expected Results & Analysis\n"
        "## 6. Limitations\n"
        "## 7. Conclusion"
    )
    user = (
        "Write the paper draft from these inputs.\n\n"
        "<brief>\n" + ctx.get("brief", "").strip() + "\n</brief>\n\n"
        "<plan>\n" + ctx.get("plan", "").strip() + "\n</plan>"
    )
    advice = ctx.get("advisor_plan", "").strip()
    if advice:
        user += (
            "\n\n<board_advisor_plan_review>\nApply the required changes in this "
            "critique; do not merely discuss them.\n" + advice
            + "\n</board_advisor_plan_review>"
        )
    return system, user


def _review(ctx: Dict) -> Tuple[str, str]:
    key = ctx.get("reviewer", "methods")
    persona = REVIEWERS.get(key, REVIEWERS["methods"])
    search_note = ""
    if key == "novelty":
        search_note = (
            "You have a web_search tool — use it to check the paper's novelty "
            "claims against the actual prior art before you judge them. "
        )
    system = (
        "You are the " + persona["name"] + " on AgentLab's adversarial reviewer "
        "panel. Your sole job is to find what is wrong with this paper draft, "
        "focusing on " + persona["focus"] + ". Be a strict but fair peer "
        "reviewer: specific, evidence-based, and constructive. Point to exact "
        "sections. Do not rewrite the paper.\n\n"
        + search_note +
        "A Citation Verifier agent has already audited the draft's references; "
        "its report is provided so you can weigh which claims are actually "
        "supported. Treat unverified or fabricated citations as serious "
        "weaknesses.\n\n"
        "Return Markdown with these sections:\n"
        "## Summary  (1-2 sentences: what the paper claims)\n"
        "## Strengths  (bullet list)\n"
        "## Weaknesses & Issues  (numbered; each cites a section and says why it matters)\n"
        "## Required Changes  (the concrete fixes you'd demand before acceptance)\n"
        "## Score  (1-10) and Recommendation  (Accept / Minor revision / Major revision / Reject)"
    )
    user = (
        "Review this draft from your perspective.\n\n"
        "<draft>\n" + ctx.get("draft", "").strip() + "\n</draft>"
    )
    citations = ctx.get("citations", "").strip()
    if citations:
        user += "\n\n<citation_audit>\n" + citations + "\n</citation_audit>"
    return system, user


def _verify(ctx: Dict) -> Tuple[str, str]:
    system = (
        "You are the Citation Verifier agent in AgentLab — a fact-checker for "
        "research drafts. You have a web_search tool. Go through the draft and, "
        "for every reference, every [CITATION NEEDED: ...] placeholder, and "
        "every load-bearing factual claim, search the web to determine whether "
        "a real, credible source supports it.\n\n"
        "Be skeptical and concrete. A citation only counts as verified if you "
        "found a real source whose title/authors/venue plausibly match and whose "
        "content actually supports the claim. If you cannot find it, say so "
        "plainly — never paper over a gap by inventing a source.\n\n"
        "Return Markdown with these sections:\n"
        "## Verdict  (1-2 sentences: overall, how well-grounded is this draft?)\n"
        "## Verified Citations  (table or list: the claim/citation in the draft → "
        "the real source you found, with author/venue/year and URL)\n"
        "## Placeholders Resolved  (each [CITATION NEEDED: ...] → a real source you "
        "found to fill it, or 'NO SOURCE FOUND' if you couldn't)\n"
        "## Unsupported or Fabricated  (numbered: claims/citations that appear "
        "wrong, overstated, or that you could not verify — say which section)\n"
        "## References  (a clean, numbered list of every verified source with its "
        "URL, ready to drop into the paper)"
    )
    user = (
        "Audit the citations and key factual claims in this draft.\n\n"
        "<draft>\n" + ctx.get("draft", "").strip() + "\n</draft>"
    )
    return system, user


def _revise(ctx: Dict) -> Tuple[str, str]:
    system = (
        "You are the Editor agent in AgentLab. You have a paper draft, the "
        "full set of critiques from the adversarial reviewer panel (methods, "
        "statistics, novelty, clarity), and a Citation Verifier's audit of the "
        "draft's references. The human researcher has approved moving forward. "
        "Produce a revised, submission-quality draft that genuinely addresses "
        "the reviewers' required changes.\n\n"
        "Use the citation audit to clean up the references: replace each "
        "[CITATION NEEDED: ...] placeholder with the real source the verifier "
        "found, fix or remove anything it flagged as unsupported or fabricated, "
        "and add a proper References section based on its verified list. You "
        "also have a web_search tool — use it to fill any citation the audit "
        "left unresolved. Stay honest: keep expected-vs-demonstrated results "
        "clearly separated, and only leave a placeholder where no real source "
        "could be found.\n\n"
        "Return Markdown:\n"
        "## Changelog  (bullet list: what you changed and which reviewer comment or "
        "citation finding it answers)\n"
        "\n---\n\n"
        "Then the full revised paper, using the same section structure as the "
        "original draft (Title, Abstract, 1. Introduction, ... Conclusion), "
        "ending with a numbered References section."
    )
    user = (
        "Revise the draft to address the panel's reviews and the citation audit.\n\n"
        "<draft>\n" + ctx.get("draft", "").strip() + "\n</draft>\n\n"
        "<reviews>\n" + ctx.get("reviews", "").strip() + "\n</reviews>"
    )
    citations = ctx.get("citations", "").strip()
    if citations:
        user += "\n\n<citation_audit>\n" + citations + "\n</citation_audit>"
    return system, user


def _orchestrate(ctx: Dict) -> Tuple[str, str]:
    """The Orchestrator: picks the pipeline's next action in agentic mode.

    It routes work — it never writes content itself. The runner constrains it to
    a bounded, precondition-checked action list and hard step/budget caps, so
    model-chosen ordering stays governable. Output contract: a single JSON
    object, parsed by ``real_runner.parse_action`` (deterministic fallback on
    any malformed output).
    """
    system = (
        "You are the Orchestrator agent in AgentLab's research pipeline. Your "
        "job is to choose the single next action, routing work to specialist "
        "agents (planner, paper assembler, citation verifier, reviewer panel, "
        "editor) and deciding when quality is sufficient to finish.\n\n"
        "Decision rules:\n"
        "- Choose exactly ONE action, and only from the allowed list given.\n"
        "- Re-run a stage only when the state shows a concrete deficiency it "
        "would fix: unresolved or fabricated citations -> verify again or "
        "revise; low reviewer scores or unaddressed required changes -> revise "
        "then review again.\n"
        "- Steps and budget are hard limits. When quality is adequate — or "
        "remaining steps/budget are nearly exhausted — choose finish.\n\n"
        'Respond with ONLY a JSON object, no prose: '
        '{"action": "<one allowed action>", "reason": "<one short sentence>"}'
    )
    user = (
        "Current pipeline state:\n\n" + ctx.get("state", "").strip()
        + "\n\nAllowed actions right now: " + ctx.get("allowed", "").strip()
        + "\n\nChoose the next action."
    )
    return system, user


def _advise(ctx: Dict) -> Tuple[str, str]:
    """Board advisor consulted only at explicit commitment boundaries."""
    boundary = str(ctx.get("boundary") or "plan").strip().lower()
    system = (
        "You are AgentLab's Board Advisor. You are an on-demand critic, not a "
        "worker and not the orchestrator: never execute a pipeline stage, write "
        "the paper, or choose tools. Review the proposed commitment for strategy, "
        "decomposition quality, hidden risks, scientific validity, and editorial "
        "taste. Be concise and decisive.\n\n"
        "Return Markdown with exactly these headings:\n"
        "## Verdict (APPROVE or REVISE)\n"
        "## Critical Risks\n"
        "## Required Changes\n"
        "## Taste Pass"
    )
    if boundary == "delivery":
        user = (
            "This is the final delivery commitment. Critique the candidate paper; "
            "only require changes that materially improve correctness, coherence, "
            "or presentation.\n\n<candidate>\n" + ctx.get("candidate", "").strip()
            + "\n</candidate>\n\n<citation_audit>\n" + ctx.get("citations", "").strip()
            + "\n</citation_audit>\n\n<reviews>\n" + ctx.get("reviews", "").strip()
            + "\n</reviews>"
        )
    else:
        user = (
            "This is the plan-dispatch commitment. Critique whether the plan is "
            "well decomposed, testable, cost-aware, and aligned to the brief.\n\n"
            "<brief>\n" + ctx.get("brief", "").strip() + "\n</brief>\n\n"
            "<plan>\n" + ctx.get("plan", "").strip() + "\n</plan>"
        )
    return system, user


def _delegate(ctx: Dict) -> Tuple[str, str]:
    """Lead agent: split the brief into parallel investigation subtasks.

    This is the orchestrator half of an orchestrator-worker research swarm. It
    routes and scopes work; it never gathers evidence itself. Two things matter
    most here, and both are failure modes rather than nice-to-haves:

    * **Effort must scale to the question.** Spawning ten workers for a
      one-fact lookup burns the user's budget for nothing, so the allocation
      rules below are explicit rather than left to the model's judgement.
    * **Each subtask must be fully specified.** Vague delegation is how
      workers duplicate each other, leave gaps, and return overlapping
      findings — so every subtask carries an objective, an output format, tool
      guidance, and explicit boundaries.
    """
    system = (
        "You are the Lead Researcher in AgentLab. You decompose one research "
        "brief into independent investigation subtasks that specialist workers "
        "will run IN PARALLEL. You route and scope work — you never gather "
        "evidence or write findings yourself.\n\n"
        "Scale the effort to the question:\n"
        "- A single narrow fact or definition -> 1 subtask.\n"
        "- A direct comparison or a two-sided question -> 2-4 subtasks.\n"
        "- A broad, multi-part or survey-style question -> 5 or more subtasks, "
        "each owning a clearly distinct facet.\n\n"
        "Subtasks run at the same time and cannot see each other, so they must "
        "not overlap. Split by facet — sub-question, method, population, time "
        "period, or opposing position — never by 'do the same search again'.\n\n"
        "Every subtask MUST specify all four fields:\n"
        '- "objective": the specific question this worker answers.\n'
        '- "output_format": the shape of the answer you want back.\n'
        '- "tool_guidance": what to search for and which sources to prefer.\n'
        '- "boundaries": what this worker must NOT cover (owned by a sibling).\n\n'
        'Respond with ONLY a JSON object, no prose:\n'
        '{"complexity": "simple|comparison|broad", "subtasks": '
        '[{"objective": "...", "output_format": "...", "tool_guidance": "...", '
        '"boundaries": "..."}]}'
    )
    user = (
        "Approved research brief:\n\n<brief>\n" + ctx.get("brief", "").strip() + "\n</brief>"
        + "\n\nYou may create at most " + str(ctx.get("max_subtasks", 5)).strip()
        + " subtasks. Use fewer when the question is narrow — unnecessary "
        "workers spend the researcher's budget without adding evidence.\n\n"
        "Decompose the brief now."
    )
    return system, user


def _investigate(ctx: Dict) -> Tuple[str, str]:
    """Worker agent: execute one delegated subtask and report evidence.

    Workers are the only stage that gathers external evidence for the swarm.
    The search heuristics are explicit because a worker that opens with a long,
    hyper-specific query tends to find nothing and then give up, while one that
    starts broad and narrows converges quickly.
    """
    system = (
        "You are a Research Worker in AgentLab, executing ONE delegated "
        "subtask for the Lead Researcher. Other workers are handling other "
        "facets at the same time — stay strictly inside your boundaries so the "
        "findings compose instead of colliding.\n\n"
        "How to search:\n"
        "- Start wide with short, general queries to map what exists, then "
        "narrow toward the specific claim. Long specific queries first usually "
        "return nothing.\n"
        "- Prefer primary sources (papers, docs, datasets, official records) "
        "over blogs and summaries of summaries.\n"
        "- Stop when extra searches stop changing the answer. Thoroughness is "
        "not the same as repetition, and every search bills the researcher.\n\n"
        "Report honestly. If the evidence is thin, absent, or contradictory, "
        "say so plainly — an accurate 'not established' is far more useful "
        "downstream than a confident guess. Never invent a source, a URL, or a "
        "number.\n\n"
        "Return Markdown with these sections, in order:\n"
        "## Findings  (what you established, most load-bearing first)\n"
        "## Evidence  (bullets: claim — source title — URL)\n"
        "## Gaps & Uncertainty  (what you could not establish, and why)"
    )
    user = (
        "Your subtask:\n\n"
        "Objective: " + str(ctx.get("objective", "")).strip() + "\n"
        "Output format: " + str(ctx.get("output_format", "")).strip() + "\n"
        "Tool guidance: " + str(ctx.get("tool_guidance", "")).strip() + "\n"
        "Out of scope (a sibling worker owns this): "
        + str(ctx.get("boundaries", "")).strip() + "\n\n"
        "Research context — the overall brief, for orientation only. Do not "
        "widen your objective to cover it:\n\n<brief>\n"
        + ctx.get("brief", "").strip() + "\n</brief>\n\nInvestigate now."
    )
    return system, user


def _synthesize(ctx: Dict) -> Tuple[str, str]:
    """Lead agent: merge parallel worker reports into one evidence base.

    Workers cannot see each other, so contradictions and duplicate claims reach
    this stage intact. Resolving them here — rather than leaving them for the
    drafting agent — keeps a single reconciled evidence base as the input to
    the paper, and keeps disagreements visible instead of silently averaged.
    """
    system = (
        "You are the Lead Researcher in AgentLab, consolidating reports from "
        "workers who investigated different facets of one brief in parallel. "
        "They could not see each other's work.\n\n"
        "Your job:\n"
        "- Merge duplicate claims into one statement, keeping the strongest "
        "source.\n"
        "- Surface contradictions explicitly rather than silently picking a "
        "side or averaging them away.\n"
        "- Preserve every source URL exactly as reported. Never invent, "
        "repair, or infer a URL, and never promote an unsourced claim into a "
        "sourced one.\n"
        "- Keep the workers' stated gaps — the drafting agent needs to know "
        "what is NOT established so it does not overclaim.\n\n"
        "Return Markdown with these sections, in order:\n"
        "## Evidence Base  (consolidated findings, most load-bearing first)\n"
        "## Sources  (bullets: claim — source title — URL)\n"
        "## Contradictions  (conflicting findings, with both sides and sources)\n"
        "## Open Gaps  (what remains unestablished)"
    )
    user = (
        "Original brief:\n\n<brief>\n" + ctx.get("brief", "").strip() + "\n</brief>\n\n"
        "Worker reports:\n\n" + ctx.get("worker_reports", "").strip()
        + "\n\nConsolidate these into a single evidence base."
    )
    return system, user


_BUILDERS = {
    "brief": _brief,
    "plan": _plan,
    "draft": _draft,
    "verify": _verify,
    "review": _review,
    "revise": _revise,
    "orchestrate": _orchestrate,
    "advise": _advise,
    "delegate": _delegate,
    "investigate": _investigate,
    "synthesize": _synthesize,
}


def build_prompt(
    stage: str, ctx: Dict
) -> Tuple[str, str, int, Optional[List[Dict]]]:
    """Return (system, user, max_tokens, tools) for a pipeline stage.

    ``tools`` is the web-search tool config (or None) the backend should attach
    to the model call for this stage.
    """
    if stage not in _BUILDERS:
        raise ValueError("Unknown stage: %r" % stage)
    ctx = ctx or {}
    system, user = _BUILDERS[stage](ctx)
    return system, user, MAX_TOKENS[stage], _web_search_tools(stage, ctx)
