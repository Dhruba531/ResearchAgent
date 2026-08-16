// The operator console.
//
// It drives one research run from idea to published paper through a series of
// HUMAN GATES. That gating is the product: an agent does the work, but a person
// must approve at each checkpoint before it proceeds — and crucially, before it
// spends money.
//
//     idea → brief → [G1 approve brief] → cost estimate → [G2 approve spend]
//          → run executes → live logs → artifacts → reviewer findings
//          → [G3 revisions] → [G4 approve final export] → paper
//
// Each gate maps to a permission in `src/lib/permissions.tsx`, so what a user
// can approve depends on their role.
//
// This file owns the shared state and composes the surfaces; each surface lives
// in `src/components/console/`:
//
//   primitives   small shared building blocks
//   gating       Gated / RoleBanner — disable-and-explain, never hide
//   navigation   sidebar, topbar, project rail, new-project sheet
//   setup        backend connection, the research question
//   gates        DecisionDialog, BriefCard (G1), RunSetupCard (G2)
//   execution    live logs, artifacts, agent actions, results
//   review       reviewer findings
//   timeline     the vertical progress rail
//   export-gate  FinalExport (G4), groundedness checks
//   settings     provider API keys, usage against budget
//   revisions    RevisionGate (G3)
//
// Recurring patterns worth learning once:
//   • async action:  setBusy(true) → try/catch/finally → toast → setBusy(false)
//     The `finally` matters: without it a failed request leaves a spinner stuck.
//   • gating:        <Gated perm="run:start"> disables and explains.
//   • confirmation:  irreversible or costly actions route through DecisionDialog.
//   • lifting state: children receive callbacks (onRunUpdated, onChange) and
//                    report upward; this file owns the shared state.

import { createFileRoute, isRedirect, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { WorkspaceTheme } from "@/components/workspace-theme";
import {
  getCapabilities,
  getUsage,
  getProject,
  getRun,
  hasRealBackend,
  health,
  listProjects,
  listReviews,
  logout as apiLogout,
  me,
  openRunLogs,
  type BriefOut,
  type LogEvent,
  type ProjectOut,
  type ReviewFindingOut,
  type RunOut,
  type UserOut,
  type CapabilitiesOut,
  type UsageOut,
} from "@/lib/api";
import { AuthProvider } from "@/lib/permissions";
import { Dot, StateCard, friendlyError } from "@/components/console/primitives";
import { ProviderKeysGate, RoleBanner } from "@/components/console/gating";
import {
  ConsoleSidebar,
  ConsoleTopbar,
  NewProjectSheet,
  ProjectRail,
} from "@/components/console/navigation";
import { AgentConnectionPanel, IdeaCard } from "@/components/console/setup";
import { BriefCard, RunSetupCard } from "@/components/console/gates";
import {
  AgenticActionsCard,
  ArtifactsAndDraft,
  ExecutionResultsCard,
  LiveLogs,
} from "@/components/console/execution";
import { ReviewerPanel } from "@/components/console/review";
import { StatusTimeline } from "@/components/console/timeline";
import { FinalExport } from "@/components/console/export-gate";
import { UsageBudgetPanel } from "@/components/console/settings";
import { RevisionGate } from "@/components/console/revisions";

export const Route = createFileRoute("/console")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    tl: typeof search.tl === "string" && search.tl.length > 0 ? search.tl : undefined,
  }),
  // Route guard: the console is client-only and requires a valid session.
  // A missing, expired, or unverifiable session bounces to /auth before the
  // workspace renders so protected UI never flashes.
  beforeLoad: async ({ location }) => {
    try {
      const user = await me();
      if (!user) {
        throw redirect({
          to: "/auth",
          search: { redirect: location.href },
        });
      }
    } catch (err) {
      if (isRedirect(err)) throw err;
      throw redirect({
        to: "/auth",
        search: { redirect: location.href },
      });
    }
  },
  pendingComponent: () => (
    <main className="theme-console grid min-h-screen place-items-center bg-background px-6">
      <div className="panel max-w-md p-6 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-panel-border bg-background font-serif text-foreground">
          AL
        </div>
        <p className="mono-label">checking session</p>
      </div>
    </main>
  ),
  head: () => ({
    meta: [
      { title: "Console — AgentLab" },
      {
        name: "description",
        content:
          "Operator console for governed agent research runs: brief approval, cost gates, live logs, artifacts, reviewer panel, and final export.",
      },
    ],
  }),
  component: ConsolePage,
});

// The semantic colour vocabulary for this file. Note it is a SEPARATE type
// from `Tone` in `components/campaign/primitives.tsx` — same idea, different
// member names ("error" here vs "danger" there). Duplication worth collapsing
// if this file is ever split up.

function ConsolePage() {
  // ── Session ──────────────────────────────────────────────────────────────
  // `authChecked` is separate from `user` on purpose. Before the check
  // completes both are falsy, but "still checking" and "definitely signed out"
  // demand different UI — without this flag the page would flash a signed-out
  // state before the session resolved.
  const [user, setUser] = useState<UserOut | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // ── Projects ─────────────────────────────────────────────────────────────
  // `activeId` (the selection) is deliberately separate from `activeProject`
  // (the loaded detail). Changing the id triggers a fetch; keeping them apart
  // means the previous project stays on screen while the next one loads,
  // instead of the page blanking between the two.
  const [projects, setProjects] = useState<ProjectOut[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectOut | null>(null);

  // ── The active project's workflow state ──────────────────────────────────
  // These five mirror the gate sequence described in the file header:
  // brief (G1) → run (G2) → live events → findings → export (G4).
  const [brief, setBrief] = useState<BriefOut | null>(null);
  const [activeRun, setActiveRun] = useState<RunOut | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [findings, setFindings] = useState<ReviewFindingOut[]>([]);
  const [exported, setExported] = useState(false);

  // ── Account-level metadata ───────────────────────────────────────────────
  // What this deployment can do, and how much has been spent. Both feed the
  // gating logic — controls that would fail are disabled rather than offered.
  const [capabilities, setCapabilities] = useState<CapabilitiesOut | null>(null);
  const [usage, setUsage] = useState<UsageOut | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);

  // ── Refs for things that are NOT rendered ────────────────────────────────
  // A socket handle and an interval id are infrastructure, not display data.
  // Holding them in `useRef` avoids a re-render every time they change — and
  // crucially, a ref survives re-renders so cleanup can still reach them.
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const navigate = useNavigate();

  // ── auth gate
  // A SECOND auth check, in addition to the route's `beforeLoad` guard above.
  // Not redundant: `beforeLoad` runs once on entry, while this also catches a
  // session expiring during a long-lived console session.
  useEffect(() => {
    // Same `cancelled` guard as `LiveTelemetry` in index.tsx — stops a late
    // response from navigating a component that has already unmounted.
    let cancelled = false;
    me()
      .then((u) => {
        if (cancelled) return;
        if (!u) {
          navigate({ to: "/auth", search: { redirect: window.location.href }, replace: true });
          return;
        }
        setUser(u);
        setAuthChecked(true);
      })
      .catch(() => {
        if (!cancelled) {
          navigate({ to: "/auth", search: { redirect: window.location.href }, replace: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // ── load projects when logged in
  const refreshProjects = async () => {
    try {
      const list = await listProjects();
      setProjects(list);
      if (list.length > 0 && activeId == null) setActiveId(list[0].id);
    } catch (e) {
      toast.error(friendlyError(e, "Could not load projects"));
    }
  };

  useEffect(() => {
    if (authChecked) void refreshProjects();
    // The eslint-disable suppresses the exhaustive-deps warning about
    // `refreshProjects`, which is redefined on every render and would therefore
    // re-trigger this effect endlessly if listed.
    //
    // This suppression appears several times below. It works, but it is a smell
    // — the idiomatic fixes are to wrap the function in `useCallback` or to
    // move the fetch into TanStack Query, as `lib/campaign-queries.ts` does.
    // Treat each one as a marker for future cleanup rather than a pattern to
    // copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked]);

  // ── capabilities + monthly usage drive gating across the console
  const refreshMeta = async () => {
    setMetaLoading(true);
    // `Promise.all` runs both requests CONCURRENTLY rather than sequentially,
    // so the pair costs one round trip instead of two.
    //
    // The per-promise `.catch(() => null)` is the important detail: `Promise.all`
    // rejects as soon as ANY input rejects, which would discard a successful
    // result alongside the failed one. Catching inside each promise converts a
    // failure into `null`, so one endpoint being down does not blank the other.
    const [caps, use] = await Promise.all([
      getCapabilities().catch(() => null),
      getUsage().catch(() => null),
    ]);
    setCapabilities(caps);
    setUsage(use);
    setMetaLoading(false);
  };

  useEffect(() => {
    if (!authChecked) return;
    void refreshMeta();
    const id = setInterval(() => void refreshMeta(), 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked]);

  useEffect(() => {
    // Refresh spend immediately when a run finishes, rather than waiting up to
    // 60 seconds for the next poll. A run is what consumes budget, so this is
    // exactly the moment the usage figures become stale.
    if (
      authChecked &&
      activeRun &&
      ["completed", "failed", "cancelled"].includes(activeRun.status)
    ) {
      void refreshMeta();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.status]);

  // ── refresh active project & derived state
  const loadActive = async (projectId: number) => {
    try {
      const p = await getProject(projectId);
      setActiveProject(p);
      setActiveRun(p.latest_run ?? null);
      setFindings(p.review_findings ?? []);
      setExported(false);

      // brief: try to pull the latest brief from the project payload if the
      // backend inlines it; otherwise the user can generate a fresh one.
      // Defensive field probing: the backend may inline the brief under either
      // name, or omit it entirely. The intersection casts (`ProjectOut & {...}`)
      // tell TypeScript about fields absent from the declared type — a sign
      // that `ProjectOut` in lib/api.ts has drifted from what the API actually
      // returns. The proper fix is to add these fields to that interface.
      const bp =
        (p as ProjectOut & { latest_brief?: BriefOut | null; brief?: BriefOut | null })
          .latest_brief ??
        (p as ProjectOut & { brief?: BriefOut | null }).brief ??
        null;
      setBrief(bp);
    } catch (e) {
      toast.error(friendlyError(e, "Could not load project"));
    }
  };

  useEffect(() => {
    if (activeId != null) void loadActive(activeId);
  }, [activeId]);

  // ── live logs subscription
  //
  // THE MOST INTRICATE EFFECT IN THE FILE. It does four things:
  //   1. tears down any previous socket and poll timer
  //   2. seeds the view with historical logs already on the run
  //   3. opens a WebSocket for live updates (only if the run is active)
  //   4. falls back to HTTP polling if the socket fails
  //
  // The fallback is what makes it long. The design principle is the same as in
  // `campaigns.$id.tsx`: a failed socket must degrade to something slower, not
  // to a broken page.
  useEffect(() => {
    // Reset log stream when the active run changes.
    // This teardown runs at the START of the effect as well as in the cleanup
    // below, because switching runs must not leave the previous run's socket
    // open or its log lines on screen.
    setEvents([]);
    wsRef.current?.close();
    wsRef.current = null;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    if (!activeRun) return;
    // A finished run emits nothing further, so there is no point opening a
    // socket — just show the stored logs and stop.
    if (!["queued", "running", "review"].includes(activeRun.status)) {
      // seed with historical logs if present
      if (activeRun.logs?.length) {
        setEvents(activeRun.logs.map((l) => ({ type: "log", ...l })));
      }
      return;
    }

    // Seed with historical logs first
    if (activeRun.logs?.length) {
      setEvents(activeRun.logs.map((l) => ({ type: "log", ...l })));
    }

    try {
      const ws = openRunLogs(activeRun.id, (ev) => {
        // NOTE: unbounded growth. Unlike the search trace in
        // `campaigns.$id.tsx`, which caps its buffer with `.slice(-400)`, this
        // array grows for the life of the run. Fine for a run of ordinary
        // length; a very long or very chatty run would accumulate memory.
        setEvents((cur) => [...cur, ev]);
        if (ev.type === "status" && ev.status) {
          setActiveRun((r) => (r ? { ...r, status: ev.status ?? r.status } : r));
          // On a terminal status, fetch the full record once more. The socket
          // reports the status change but not the artifacts, final cost, or
          // review findings the backend writes as the run closes out — so
          // without this refresh the page would show "completed" with none of
          // the results attached.
          if (["completed", "failed", "cancelled"].includes(ev.status)) {
            // final refresh to pull cost/draft/artifacts/findings
            void (async () => {
              try {
                const fresh = await getRun(activeRun.id);
                setActiveRun(fresh);
                if (activeId != null) {
                  const flist = await listReviews(activeId);
                  setFindings(flist);
                }
              } catch {
                /* ignore */
              }
            })();
          }
        }
      });
      ws.onerror = () => {
        // Fallback: poll run status if the WS handshake fails (e.g. auth quirk).
        // The user sees a slightly less responsive page rather than a dead one.
        //
        // The `pollRef.current` guard makes this IDEMPOTENT: `onerror` can fire
        // more than once, and without it each firing would start another timer,
        // multiplying the request rate with every error.
        if (pollRef.current) return;
        pollRef.current = setInterval(async () => {
          try {
            const fresh = await getRun(activeRun.id);
            setActiveRun(fresh);
            if (fresh.logs) {
              setEvents(fresh.logs.map((l) => ({ type: "log", ...l })));
            }
            // The polling loop stops ITSELF once the run reaches a terminal
            // state — otherwise it would keep hitting the backend every three
            // seconds for a run that can no longer change.
            if (["completed", "failed", "cancelled"].includes(fresh.status)) {
              if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
            }
          } catch {
            /* ignore */
          }
        }, 3000);
      };
      wsRef.current = ws;
    } catch {
      /* ignore */
    }

    // Cleanup must tear down BOTH mechanisms, since either could be active.
    // Missing either one leaks: a socket that stays open, or a timer that polls
    // forever after the user navigates away.
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeRun?.id, activeRun?.status]);
  // ^ Depends on the id AND the status — using `activeRun` itself would re-run
  //   this whole teardown/setup cycle on every unrelated field change.

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      // Clear the in-app/FastAPI session cookie first, then the Supabase
      // OAuth session (Google/Apple/etc.) so the next visit is unauthenticated.
      // ORDER MATTERS, and so does the `.catch`. The FastAPI session is cleared
      // first, but its failure is swallowed — if the backend is unreachable we
      // must still clear the local Supabase session, or the user would be
      // trapped in a signed-in UI they cannot sign out of.
      await apiLogout().catch(() => {
        /* backend may be unavailable; still clear local session */
      });
      await supabase.auth.signOut();
      toast.success("Signed out");
      navigate({ to: "/auth", replace: true });
    } catch {
      toast.error("Could not sign out.");
      setLoggingOut(false);
    }
  };

  // Two derived booleans driving the gate sequence: the run cannot start until
  // the brief is approved, and export cannot happen until the run completes.
  // Deriving them on each render (rather than storing them in state) means they
  // can never fall out of sync with the data they come from.
  const briefApproved = Boolean(brief?.is_approved);
  const runComplete = activeRun?.status === "completed";

  // EARLY RETURN while the session is being verified. Everything below this
  // point can safely assume an authenticated `user`, which is what keeps the
  // main render free of null checks.
  if (!authChecked || !user) {
    return (
      <main className="theme-console grid min-h-screen place-items-center bg-background px-6">
        <div className="panel max-w-md p-6 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-panel-border bg-background font-serif text-foreground">
            AL
          </div>
          <p className="mono-label">checking session</p>
          <h1 className="mt-3 font-serif text-3xl text-foreground">Console requires sign in.</h1>
        </div>
      </main>
    );
  }

  return (
    <AuthProvider user={user}>
      <div className="theme-console relative flex min-h-screen bg-background">
        <WorkspaceTheme />
        <ConsoleSidebar user={user} onLogout={handleLogout} loggingOut={loggingOut} />

        <div className="min-w-0 flex-1">
          <ConsoleTopbar user={user} onLogout={handleLogout} loggingOut={loggingOut} />

          <main className="relative mx-auto w-full max-w-[1280px] px-6 pb-24 pt-6">
            {/* Command bar */}
            <section
              id="workspace"
              className="sticky top-0 z-30 -mx-6 border-b border-border/70 bg-background/85 px-6 py-4 backdrop-blur-md"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
                    <span>agentlab</span>
                    <span className="text-primary">/</span>
                    <span className="text-foreground">workspace</span>
                  </div>
                  <h1 className="mt-1 truncate font-serif text-[26px] leading-tight tracking-tight text-foreground">
                    {activeProject ? activeProject.title : "Workspace"}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  <span className="hidden items-center gap-2 rounded-full border border-panel-border bg-panel px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground sm:inline-flex">
                    <Dot tone={hasRealBackend() ? "success" : "warning"} />{" "}
                    {hasRealBackend() ? "backend live" : "no backend"}
                  </span>
                  <NewProjectSheet
                    onCreate={(p) => {
                      setProjects((cur) => [p, ...cur]);
                      setActiveId(p.id);
                    }}
                  />
                </div>
              </div>
            </section>

            {/* Intro + project rail */}
            <section className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:items-start">
              <div className="panel relative overflow-hidden p-5">
                <div className="gradient-rule absolute inset-x-0 top-0" />
                <p className="mono-label">research workspace</p>
                <p className="mt-3 text-[14px] leading-[1.65] text-muted-foreground">
                  Pick a project, edit its brief, set a budget, then start a run. Logs stream live;
                  the export stays locked until the final gate is signed off.
                </p>
              </div>

              <div className="min-w-0">
                <div className="mb-3 flex items-center justify-between">
                  <span className="mono-label">projects</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {projects.length} total
                  </span>
                </div>
                <ProjectRail projects={projects} activeId={activeId} setActiveId={setActiveId} />
              </div>
            </section>

            {/* State strip */}
            <section
              id="pipeline"
              className="panel mt-6 grid divide-y divide-panel-border overflow-hidden sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4 [&>*+*]:sm:border-l [&>*+*]:sm:border-panel-border"
            >
              <StateCard
                label="PROJECT"
                value={activeProject?.status ?? (activeId ? "loading" : "none")}
                caption="current workspace state"
              />
              <StateCard
                label="BRIEF"
                value={
                  brief ? (brief.is_approved ? "approved" : `v${brief.version} draft`) : "none"
                }
                caption="human gate G1"
              />
              <StateCard
                label="RUN"
                value={activeRun ? activeRun.status : "not started"}
                caption={activeRun ? `run #${activeRun.id} · gate G2` : "gate G2"}
              />
              <StateCard
                label="COST"
                value={
                  activeRun
                    ? `$${activeRun.actual_cost.toFixed(2)}`
                    : activeProject
                      ? "pending"
                      : "—"
                }
                caption={
                  usage
                    ? `$${usage.remaining.toFixed(2)} left this month`
                    : activeRun
                      ? `of $${activeRun.budget_threshold.toFixed(2)}`
                      : "actual · budget"
                }
              />
            </section>

            {/* Connection + provider keys */}
            <section className="mt-8 grid gap-6">
              <AgentConnectionPanel
                onChange={() => {
                  setProjects([]);
                  setActiveId(null);
                  setActiveProject(null);
                  setActiveRun(null);
                  setBrief(null);
                  setEvents([]);
                  setFindings([]);
                  void refreshProjects();
                  health()
                    .then(() => toast.success("Backend healthy"))
                    .catch(() => {
                      /* AgentConnection panel already shows the Test result */
                    });
                }}
              />
              <ProviderKeysGate />
              <UsageBudgetPanel usage={usage} capabilities={capabilities} loading={metaLoading} />
            </section>

            <RoleBanner />

            {activeProject ? (
              <>
                <section className="mt-8 grid gap-6 xl:grid-cols-2">
                  <IdeaCard project={activeProject} onIdeaSaved={setActiveProject} />
                  <BriefCard project={activeProject} brief={brief} setBrief={setBrief} />
                </section>

                <section className="mt-6 grid gap-6 xl:grid-cols-2">
                  <RunSetupCard
                    project={activeProject}
                    briefApproved={briefApproved}
                    activeRun={activeRun}
                    capabilities={capabilities}
                    usage={usage}
                    onRunStarted={(run) => {
                      setActiveRun(run);
                      setEvents([]);
                    }}
                    onRunCancelled={setActiveRun}
                  />
                  <LiveLogs run={activeRun} events={events} />
                </section>

                <section className="mt-6 space-y-6">
                  <ArtifactsAndDraft run={activeRun} exportApproved={exported} />
                  <RevisionGate run={activeRun} onRunUpdated={setActiveRun} />
                  <AgenticActionsCard run={activeRun} />
                  <ExecutionResultsCard run={activeRun} />
                </section>

                <section id="review" className="mt-6 space-y-6">
                  <StatusTimeline
                    project={activeProject}
                    brief={brief}
                    activeRun={activeRun}
                    findings={findings}
                    exported={exported}
                    actorName={user?.name || user?.email || "user"}
                    projects={projects}
                    onSelectProject={setActiveId}
                  />
                  <ReviewerPanel findings={findings} />
                </section>

                <section id="export" className="mt-6 space-y-4">
                  <FinalExport
                    project={activeProject}
                    runComplete={Boolean(runComplete)}
                    hasFindings={findings.length > 0}
                    activeRun={activeRun}
                    onExported={() => setExported(true)}
                  />
                  {exported && (
                    <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 font-mono text-[12px] text-foreground">
                      Final package approved for project #{activeProject.id}.
                    </div>
                  )}
                </section>
              </>
            ) : (
              <section className="panel mt-10 overflow-hidden p-10 text-center">
                <p className="mono-label">no project selected</p>
                <h2 className="mt-3 font-serif text-3xl text-foreground">
                  Create your first research project.
                </h2>
                <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
                  Use the “New project” button above. Each project moves through idea, brief, run,
                  review, export gates.
                </p>
              </section>
            )}
          </main>
        </div>

        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{ style: { fontFamily: "var(--font-mono)" } }}
        />
      </div>
    </AuthProvider>
  );
}
