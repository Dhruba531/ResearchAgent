// The vertical progress rail down the page. `toneStyles` is the colour
// lookup, `StatusTimeline` builds the event list, and `TimelineDetailSheet`
// is the drill-down.

import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  type BriefOut,
  type ProjectOut,
  type ReviewFindingOut,
  type RunOut,
  type GroundednessReport,
  artifactUrl,
  type ArtifactOut,
} from "@/lib/api";
import { BentoHead, Dot, MetaChip } from "./primitives";
import { DecisionDialog } from "./gates";

export type TimelineTone = "muted" | "pending" | "active" | "success" | "warning" | "danger";

/**
 * One entry on the timeline.
 *
 * `tone` and `state` look redundant but are not: `state` is the SEMANTIC
 * position in the workflow (done / current / pending / skipped), while `tone`
 * is how it should LOOK. They usually correlate, but a "done" step that failed
 * still needs a danger tone, so the two are kept independent.
 */
export interface TimelineEvent {
  key: string;
  gate?: string;
  label: string;
  detail: string;
  actor: string;
  timestamp: string | null;
  tone: TimelineTone;
  state: "done" | "current" | "pending" | "skipped";
  note?: string;
  sessionRef?: string | null;
  runId?: number | null;
  artifacts?: ArtifactOut[];
  meta?: { label: string; value: string }[];
}

/**
 * Format a timestamp for display, degrading gracefully at every step.
 *
 * Three guards, because timestamps come from a backend and cannot be trusted:
 * null yields an em dash, an unparseable string is shown verbatim rather than
 * as "Invalid Date", and only a genuine date is formatted.
 */
export function formatTs(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  // `new Date("nonsense")` does not throw — it returns an Invalid Date whose
  // `getTime()` is NaN. This is the only reliable way to detect that.
  if (Number.isNaN(d.getTime())) return ts;
  // `undefined` as the locale means "use the viewer's own locale", so dates
  // render in the reader's regional format rather than a hard-coded one.
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Map a tone to its three Tailwind class strings.
 *
 * A `switch` returning full class strings, rather than the lookup object used
 * elsewhere. Same underlying constraint either way: every class must appear
 * LITERALLY in the source for Tailwind's scanner to generate it — see the note
 * in campaign/primitives.tsx `Dot`.
 *
 * Three variants per tone because each timeline row has three coloured parts:
 * the dot, the ring around it, and the chip beside it.
 */
export function toneStyles(tone: TimelineTone): { dot: string; ring: string; chip: string } {
  switch (tone) {
    case "success":
      return {
        dot: "bg-primary",
        ring: "ring-primary/30",
        chip: "border-primary/30 bg-primary/10 text-foreground",
      };
    case "active":
      return {
        dot: "bg-primary",
        ring: "ring-primary/40",
        chip: "border-primary/40 bg-primary/10 text-foreground",
      };
    case "warning":
      return {
        dot: "bg-amber-500",
        ring: "ring-amber-500/30",
        chip: "border-amber-500/30 bg-amber-500/10 text-foreground",
      };
    case "danger":
      return {
        dot: "bg-destructive",
        ring: "ring-destructive/30",
        chip: "border-destructive/30 bg-destructive/10 text-foreground",
      };
    case "pending":
      return {
        dot: "bg-muted-foreground/40",
        ring: "ring-panel-border",
        chip: "border-panel-border bg-panel/60 text-muted-foreground",
      };
    default:
      return {
        dot: "bg-muted-foreground/30",
        ring: "ring-panel-border",
        chip: "border-panel-border bg-panel/40 text-muted-foreground",
      };
  }
}

/**
 * Builds and renders the timeline from the current run state.
 *
 * The long body is mostly one large derivation: it inspects the project, brief,
 * and run and produces the ordered `TimelineEvent[]`. The timeline is therefore
 * DERIVED, never stored — which is what stops it drifting out of sync with the
 * data it describes.
 */
// Reaches the /console route's search params without importing the route
// module, which would be circular: the route imports this file.
const consoleRoute = getRouteApi("/console");

export function StatusTimeline({
  project,
  brief,
  activeRun,
  findings,
  exported,
  actorName,
  projects,
  onSelectProject,
}: {
  project: ProjectOut | null;
  brief: BriefOut | null;
  activeRun: RunOut | null;
  findings: ReviewFindingOut[];
  exported: boolean;
  actorName: string;
  projects: ProjectOut[];
  onSelectProject: (id: number) => void;
}) {
  const [gateFilter, setGateFilter] = useState<string[]>([]);
  const [sessionFilter, setSessionFilter] = useState<"all" | "current" | "pre-run">("all");
  const search = consoleRoute.useSearch();
  const navigate = useNavigate();
  const selectedKey = search.tl ?? null;
  const setSelectedKey = (key: string | null) => {
    void navigate({
      to: "/console",
      search: (prev: { tl?: string }) => ({ ...prev, tl: key ?? undefined }),
      replace: key === null,
      resetScroll: false,
    });
  };

  const events: TimelineEvent[] = useMemo(() => {
    const list: TimelineEvent[] = [];
    const runArtifacts = activeRun?.artifacts ?? [];
    const sessionRef = activeRun?.session_id ?? null;
    const runId = activeRun?.id ?? null;

    // Project created
    list.push({
      key: "project",
      gate: "init",
      label: "Project opened",
      detail: project ? `#${project.id} · ${project.title}` : "no project selected",
      actor: project ? actorName : "—",
      timestamp: null,
      tone: project ? "success" : "muted",
      state: project ? "done" : "pending",
      note: project?.objective
        ? `Objective: ${project.objective}`
        : "Workspace opened for this project.",
      meta: project
        ? [
            { label: "Project id", value: `#${project.id}` },
            { label: "Status", value: project.status },
          ]
        : undefined,
    });

    // Brief drafted
    list.push({
      key: "brief-draft",
      gate: "G1",
      label: "Brief drafted",
      detail: brief
        ? `v${brief.version} · ${brief.content_markdown.length.toLocaleString()} chars`
        : "awaiting draft",
      actor: brief ? "brief-writer agent" : "—",
      timestamp: null,
      tone: brief ? "success" : "pending",
      state: brief ? "done" : "pending",
      note: brief
        ? brief.content_markdown.slice(0, 480) + (brief.content_markdown.length > 480 ? "…" : "")
        : "The brief-writer agent has not produced a draft yet.",
      meta: brief
        ? [
            { label: "Brief id", value: `#${brief.id}` },
            { label: "Version", value: `v${brief.version}` },
            { label: "Length", value: `${brief.content_markdown.length.toLocaleString()} chars` },
          ]
        : undefined,
    });

    // Brief approval (G1)
    const briefApproved = Boolean(brief?.is_approved);
    list.push({
      key: "brief-approval",
      gate: "G1",
      label: "Brief approved",
      detail: briefApproved
        ? "human gate cleared"
        : brief
          ? "waiting for reviewer sign-off"
          : "blocked · no brief",
      actor: briefApproved ? actorName : "—",
      timestamp: null,
      tone: briefApproved ? "success" : brief ? "warning" : "muted",
      state: briefApproved ? "done" : brief ? "current" : "pending",
      note: briefApproved
        ? "Reviewer confirmed scope, methods, and success criteria for the run."
        : brief
          ? "Reviewer must approve the brief before Gate G2 (budget) unlocks."
          : "No brief exists yet — nothing to approve.",
      meta: brief
        ? [
            { label: "Brief id", value: `#${brief.id}` },
            { label: "Approved", value: briefApproved ? "yes" : "no" },
          ]
        : undefined,
    });

    // Budget / run launch (G2)
    if (activeRun) {
      list.push({
        key: "run-launch",
        gate: "G2",
        label: "Budget approved · run launched",
        detail: `run #${activeRun.id} · mode ${activeRun.mode ?? "?"} · budget $${activeRun.budget_threshold.toFixed(2)}`,
        actor: actorName,
        timestamp: activeRun.created_at,
        tone: "success",
        state: "done",
        sessionRef,
        runId,
        note: `Operator authorized a budget of $${activeRun.budget_threshold.toFixed(2)} (${activeRun.mode ?? "?"} mode) to launch this run.`,
        meta: [
          { label: "Run id", value: `#${activeRun.id}` },
          { label: "Mode", value: activeRun.mode ?? "—" },
          { label: "Budget", value: `$${activeRun.budget_threshold.toFixed(2)}` },
          { label: "Estimate", value: `$${activeRun.cost_estimate.toFixed(2)}` },
        ],
      });

      // Run started
      list.push({
        key: "run-start",
        gate: "run",
        label: "Run started",
        detail: activeRun.session_id
          ? `session ${activeRun.session_id.slice(0, 8)}`
          : `status ${activeRun.status}`,
        actor: "agent runtime",
        timestamp: activeRun.started_at,
        tone: activeRun.started_at ? "success" : "pending",
        state: activeRun.started_at
          ? "done"
          : activeRun.status === "queued"
            ? "current"
            : "pending",
        sessionRef,
        runId,
        note: activeRun.started_at
          ? "Agent runtime picked up the queued run and began executing planned steps."
          : "Run is queued and waiting for a runtime slot.",
        meta: [
          { label: "Run id", value: `#${activeRun.id}` },
          { label: "Session", value: sessionRef ?? "—" },
          { label: "Status", value: activeRun.status },
        ],
      });

      // Run terminal state
      const status = activeRun.status;
      const terminal = ["completed", "failed", "cancelled"].includes(status);
      const runTone: TimelineTone =
        status === "completed"
          ? "success"
          : status === "failed"
            ? "danger"
            : status === "cancelled"
              ? "warning"
              : "active";
      list.push({
        key: "run-end",
        gate: "run",
        label:
          status === "completed"
            ? "Run completed"
            : status === "failed"
              ? "Run failed"
              : status === "cancelled"
                ? "Run cancelled"
                : "Run in progress",
        detail: `spent $${activeRun.actual_cost.toFixed(2)} of $${activeRun.budget_threshold.toFixed(2)}`,
        actor: "agent runtime",
        timestamp: activeRun.ended_at,
        tone: runTone,
        state: terminal ? "done" : "current",
        sessionRef,
        runId,
        artifacts: runArtifacts,
        note:
          status === "completed"
            ? "Agent run finished. All artifacts below were produced during this session."
            : status === "failed"
              ? "The run terminated with an error. See logs and artifacts for diagnostics."
              : status === "cancelled"
                ? "The run was cancelled before completion."
                : "The agent is still executing planned steps.",
        meta: [
          { label: "Run id", value: `#${activeRun.id}` },
          { label: "Actual cost", value: `$${activeRun.actual_cost.toFixed(2)}` },
          { label: "Budget", value: `$${activeRun.budget_threshold.toFixed(2)}` },
          { label: "Artifacts", value: String(runArtifacts.length) },
        ],
      });
    } else {
      list.push({
        key: "run-launch",
        gate: "G2",
        label: "Budget approval · run launch",
        detail: briefApproved ? "ready to launch" : "waiting on brief",
        actor: "—",
        timestamp: null,
        tone: briefApproved ? "warning" : "muted",
        state: briefApproved ? "current" : "pending",
        note: briefApproved
          ? "Brief is approved. Operator must approve the budget to launch the run."
          : "Budget gate is blocked until the brief clears Gate G1.",
      });
    }

    // Review findings
    if (activeRun && activeRun.status === "completed") {
      const highs = findings.filter((f) => (f.severity ?? "").toLowerCase() === "high").length;
      const previews = findings
        .slice(0, 4)
        .map((f) => `• [${f.severity}] ${f.finding}`)
        .join("\n");
      list.push({
        key: "review",
        gate: "review",
        label: "Reviewer analysis",
        detail: findings.length
          ? `${findings.length} findings · ${highs} high severity`
          : "no findings raised",
        actor: "reviewer agent",
        timestamp: activeRun.ended_at,
        tone: highs > 0 ? "warning" : "success",
        state: "done",
        sessionRef,
        runId,
        note: findings.length
          ? previews + (findings.length > 4 ? `\n…and ${findings.length - 4} more` : "")
          : "Reviewer agent found no issues that need attention.",
        meta: [
          { label: "Findings", value: String(findings.length) },
          { label: "High severity", value: String(highs) },
        ],
      });
    }

    // Final export (G3)
    const finalArtifacts = runArtifacts.filter((a) =>
      ["report", "final", "package"].some((k) => (a.kind ?? "").toLowerCase().includes(k)),
    );
    list.push({
      key: "export",
      gate: "G3",
      label: "Final package approved",
      detail: exported
        ? "signed record exported"
        : activeRun?.status === "completed"
          ? "awaiting sign-off"
          : "blocked · run not complete",
      actor: exported ? actorName : "—",
      timestamp: null,
      tone: exported ? "success" : activeRun?.status === "completed" ? "warning" : "muted",
      state: exported ? "done" : activeRun?.status === "completed" ? "current" : "pending",
      sessionRef,
      runId,
      artifacts: finalArtifacts.length ? finalArtifacts : runArtifacts,
      note: exported
        ? "Operator signed off on the final package. Downloads are unlocked."
        : activeRun?.status === "completed"
          ? "Run is complete. Approve or force-export to unlock the final artifacts."
          : "Final export unlocks after the run reaches a completed state.",
      meta: [
        { label: "Exported", value: exported ? "yes" : "no" },
        { label: "Run status", value: activeRun?.status ?? "—" },
      ],
    });

    return list;
  }, [project, brief, activeRun, findings, exported, actorName]);

  const gateTypes = useMemo(() => {
    const seen = new Set<string>();
    events.forEach((e) => e.gate && seen.add(e.gate));
    return Array.from(seen);
  }, [events]);

  const preRunGates = new Set(["init", "G1"]);
  const runGates = new Set(["G2", "run", "review", "G3"]);

  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      if (gateFilter.length > 0 && (!ev.gate || !gateFilter.includes(ev.gate))) return false;
      if (sessionFilter === "pre-run" && ev.gate && !preRunGates.has(ev.gate)) return false;
      if (sessionFilter === "current" && ev.gate && !runGates.has(ev.gate)) return false;
      return true;
    });
  }, [events, gateFilter, sessionFilter]);

  const doneCount = filteredEvents.filter((e) => e.state === "done").length;

  const toggleGate = (g: string) =>
    setGateFilter((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="lifecycle"
        title="Status timeline"
        subtitle="Every gate transition, with the actor that made the call."
        meta={
          <>
            <MetaChip>
              {doneCount}/{filteredEvents.length} shown
            </MetaChip>
            {activeRun ? (
              <MetaChip tone="info">run #{activeRun.id}</MetaChip>
            ) : (
              <MetaChip tone="warning">no active run</MetaChip>
            )}
          </>
        }
      />
      <div className="border-b border-panel-border/70 bg-muted/20 px-6 py-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <span className="mono-label text-[10px]">Project</span>
            <select
              value={project?.id ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v) onSelectProject(Number(v));
              }}
              className="rounded-md border border-panel-border bg-background px-2 py-1 font-mono text-[12px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {!project && <option value="">— none —</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} · {p.title}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="mono-label text-[10px]">Run session</span>
            <select
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value as typeof sessionFilter)}
              className="rounded-md border border-panel-border bg-background px-2 py-1 font-mono text-[12px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="all">All events</option>
              <option value="pre-run">Pre-run only</option>
              <option value="current">
                {activeRun ? `Run #${activeRun.id} only` : "Current run only"}
              </option>
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <span className="mono-label text-[10px]">Gate type</span>
              {gateFilter.length > 0 && (
                <button
                  onClick={() => setGateFilter([])}
                  className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
                >
                  clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {gateTypes.map((g) => {
                const active = gateFilter.includes(g);
                return (
                  <button
                    key={g}
                    onClick={() => toggleGate(g)}
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] transition ${
                      active
                        ? "border-primary/50 bg-primary/15 text-foreground"
                        : "border-panel-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {g}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="p-6">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-panel-border bg-background/40 p-6">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 place-items-center rounded-full border border-panel-border bg-panel/60 font-mono text-sm">
                ∅
              </span>
              <div>
                <p className="font-serif text-base text-foreground">
                  No transitions match the current filters.
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {gateFilter.length > 0 && sessionFilter !== "all"
                    ? `Both gate (${gateFilter.join(", ")}) and run-session filters are active.`
                    : gateFilter.length > 0
                      ? `Gate filter is set to ${gateFilter.join(", ")}.`
                      : sessionFilter !== "all"
                        ? `Run-session filter is set to “${sessionFilter === "pre-run" ? "Pre-run only" : "Current run only"}”.`
                        : "Adjust the filters above to see lifecycle events."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {gateFilter.length > 0 && (
                <button
                  onClick={() => setGateFilter([])}
                  className="inline-flex items-center gap-1.5 rounded-md border border-panel-border bg-background px-3 py-1.5 font-mono text-[11px] text-foreground hover:border-primary/50 hover:text-primary"
                >
                  <span>×</span> Clear gate filters
                </button>
              )}
              {sessionFilter !== "all" && (
                <button
                  onClick={() => setSessionFilter("all")}
                  className="inline-flex items-center gap-1.5 rounded-md border border-panel-border bg-background px-3 py-1.5 font-mono text-[11px] text-foreground hover:border-primary/50 hover:text-primary"
                >
                  <span>↺</span> Show all events
                </button>
              )}
              {(gateFilter.length > 0 || sessionFilter !== "all") && (
                <button
                  onClick={() => {
                    setGateFilter([]);
                    setSessionFilter("all");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-[11px] font-medium text-primary-foreground hover:opacity-95"
                >
                  <span>↻</span> Reset all filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <ol className="relative space-y-5 border-l border-panel-border pl-6">
            {filteredEvents.map((ev) => {
              const styles = toneStyles(ev.tone);
              const isSelected = selectedKey === ev.key;
              return (
                <li key={ev.key} className="relative">
                  <span
                    className={`absolute -left-[27px] top-1.5 grid h-3.5 w-3.5 place-items-center rounded-full ring-4 ${styles.ring}`}
                  >
                    <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(ev.key)}
                    aria-expanded={isSelected}
                    className={`group w-full rounded-md border border-transparent px-3 py-2 -mx-3 text-left transition hover:border-panel-border hover:bg-panel/40 focus:outline-none focus:ring-1 focus:ring-primary ${
                      isSelected ? "border-panel-border bg-panel/50" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {ev.gate && (
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${styles.chip}`}
                          >
                            {ev.gate}
                          </span>
                        )}
                        <span className="font-serif text-lg leading-tight text-foreground">
                          {ev.label}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                        {formatTs(ev.timestamp)}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] leading-[1.55] text-muted-foreground">
                      {ev.detail}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">
                        actor · <span className="text-foreground/80">{ev.actor}</span>
                      </p>
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60 opacity-0 transition group-hover:opacity-100">
                        details
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <TimelineDetailSheet
        event={events.find((e) => e.key === selectedKey) ?? null}
        onClose={() => setSelectedKey(null)}
      />
    </div>
  );
}

/**
 * The slide-over panel showing one timeline event in full: its note, actor,
 * artifacts, and metadata.
 *
 * A Radix `Sheet` rather than a `Dialog`. Both are modal; a sheet slides in
 * from the edge and suits browsing detail, whereas a dialog interrupts and
 * suits decisions. Compare `DecisionDialog`, which is deliberately a dialog
 * because it demands an answer.
 */
export function TimelineDetailSheet({
  event,
  onClose,
}: {
  event: TimelineEvent | null;
  onClose: () => void;
}) {
  const open = Boolean(event);
  const styles = event ? toneStyles(event.tone) : null;
  const artifacts = event?.artifacts ?? [];
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto border-l border-panel-border bg-background p-0"
      >
        {event && styles ? (
          <>
            <SheetHeader className="space-y-3 border-b border-panel-border/70 bg-muted/20 px-6 py-5 text-left">
              <div className="flex flex-wrap items-center gap-2">
                {event.gate && (
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${styles.chip}`}
                  >
                    {event.gate}
                  </span>
                )}
                <span className={`inline-flex h-2 w-2 rounded-full ${styles.dot}`} />
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {event.state}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      window.open(window.location.href, "_blank", "noopener,noreferrer")
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border border-panel-border bg-background px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                  >
                    <span>↗</span> Open
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(window.location.href);
                        toast.success("Link copied", {
                          description: "Transition detail URL copied to clipboard.",
                        });
                      } catch {
                        toast.error("Copy failed", {
                          description: "Could not access the clipboard. Copy the URL manually.",
                        });
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-panel-border bg-background px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition hover:border-primary/50 hover:text-primary"
                  >
                    <span>⎘</span> Copy link
                  </button>
                </div>
              </div>
              <SheetTitle className="font-serif text-2xl leading-tight text-foreground">
                {event.label}
              </SheetTitle>
              <SheetDescription className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {formatTs(event.timestamp)}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-6 px-6 py-6">
              <section className="space-y-2">
                <p className="mono-label text-[10px]">Summary</p>
                <p className="text-[13px] leading-[1.6] text-foreground">{event.detail}</p>
              </section>

              <section className="grid grid-cols-2 gap-3">
                <div className="rounded-md border border-panel-border bg-panel/40 p-3">
                  <p className="mono-label text-[10px]">Actor</p>
                  <p className="mt-1 font-mono text-[12px] text-foreground">{event.actor}</p>
                </div>
                <div className="rounded-md border border-panel-border bg-panel/40 p-3">
                  <p className="mono-label text-[10px]">Run session</p>
                  <p className="mt-1 font-mono text-[12px] text-foreground">
                    {event.runId ? `#${event.runId}` : "—"}
                    {event.sessionRef ? ` · ${event.sessionRef.slice(0, 8)}` : ""}
                  </p>
                </div>
              </section>

              {event.meta && event.meta.length > 0 && (
                <section className="space-y-2">
                  <p className="mono-label text-[10px]">Metadata</p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-panel-border bg-background p-3">
                    {event.meta.map((m) => (
                      <div key={m.label} className="flex flex-col">
                        <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                          {m.label}
                        </dt>
                        <dd className="font-mono text-[12px] text-foreground">{m.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {event.note && (
                <section className="space-y-2">
                  <p className="mono-label text-[10px]">Gate note</p>
                  <p className="whitespace-pre-wrap rounded-md border border-panel-border bg-panel/40 p-3 text-[13px] leading-[1.6] text-foreground">
                    {event.note}
                  </p>
                </section>
              )}

              <section className="space-y-2">
                <p className="mono-label text-[10px]">
                  Related artifacts {artifacts.length ? `· ${artifacts.length}` : ""}
                </p>
                {artifacts.length === 0 ? (
                  <p className="rounded-md border border-dashed border-panel-border bg-background/40 p-3 font-mono text-[11px] text-muted-foreground">
                    No artifacts associated with this transition.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {artifacts.map((a, i) => {
                      const url = artifactUrl(a);
                      return (
                        <li
                          key={(a.id ?? i) + "-" + a.name}
                          className="flex items-center justify-between gap-3 rounded-md border border-panel-border bg-background p-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-mono text-[12px] text-foreground">
                              {a.name}
                            </p>
                            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                              {a.kind}
                              {a.mime_type ? ` · ${a.mime_type}` : ""}
                              {typeof a.size_bytes === "number"
                                ? ` · ${a.size_bytes.toLocaleString()} B`
                                : ""}
                            </p>
                          </div>
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 rounded-md border border-panel-border bg-panel/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground hover:border-primary/50 hover:text-primary"
                            >
                              open
                            </a>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ─── Final export ──────────────────────────────────────────────────────────

// ─── Final export ──────────────────────────────────────────────────────────

/**
 * GATE G4 — the last checkpoint: approve publication of the paper.
 *
 * Two paths through this component, and the distinction matters:
 *
 *   approve — the normal route, available once the groundedness checks pass
 *   force   — override those checks and publish anyway. Restricted to
 *             `final:force`, which only reviewers and admins hold (see the
 *             permission matrix in lib/permissions.tsx).
 *
 * "Groundedness" is the check for an AI-written paper citing sources that do
 * not exist, leaving placeholder text behind, or fabricating results — see
 * `GroundednessReport` in lib/api.ts. Forcing past a failed check is sometimes
 * legitimate (a checker false-positive), which is why the escape hatch exists
 * at all; separate state and a separate dialog make it impossible to trigger by
 * accident.
 */
