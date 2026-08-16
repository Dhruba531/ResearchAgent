// Live execution: the streaming log view, produced artifacts and draft, the
// step-by-step record of what the agent did, and the measured outcomes.

import { useEffect, useMemo, useRef } from "react";
import { listReviews, type LogEvent, type RunOut, artifactUrl } from "@/lib/api";
import { BentoHead, Dot, DotTone, MetaChip, StatTile } from "./primitives";
import { FinalExport } from "./export-gate";

export function LiveLogs({ run, events }: { run: RunOut | null; events: LogEvent[] }) {
  // Auto-scroll to the newest line — the same ref-plus-effect pattern as
  // `SearchTracePanel` in campaigns.$id.tsx, and for the same reason: scroll
  // position is not expressible as React state.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [events.length]);

  // Tally warnings and errors in one pass so the header can summarise the
  // stream without the user reading it. Memoised because a busy run re-renders
  // this component on every incoming frame.
  const counts = useMemo(() => {
    let warn = 0;
    let err = 0;
    let status = 0;
    for (const e of events) {
      if (e.type === "status") status++;
      else if (e.level === "warning") warn++;
      else if (e.level === "error") err++;
    }
    return { total: events.length, warn, err, status };
  }, [events]);

  const running = (run?.status ?? "").toLowerCase() === "running";
  const streamTone: DotTone = running ? "success" : run ? "muted" : "muted";

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="transcript · gate g2"
        title="Live session stream"
        subtitle="WebSocket feed from the orchestrator — status transitions, tool calls, and observations arrive in real time."
        meta={
          run ? (
            <>
              <MetaChip tone={streamTone}>{running ? "streaming" : "idle"}</MetaChip>
              <MetaChip>run #{run.id}</MetaChip>
            </>
          ) : (
            <MetaChip>no run</MetaChip>
          )
        }
      />
      <div className="grid grid-cols-2 gap-px bg-panel-border sm:grid-cols-4">
        <div className="bg-panel p-3">
          <div className="mono-label">events</div>
          <div className="mt-1 font-mono text-sm text-foreground">{counts.total}</div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">status</div>
          <div className="mt-1 font-mono text-sm text-foreground">{counts.status}</div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">warnings</div>
          <div
            className={`mt-1 font-mono text-sm ${counts.warn ? "text-warning" : "text-foreground"}`}
          >
            {counts.warn}
          </div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">errors</div>
          <div
            className={`mt-1 font-mono text-sm ${counts.err ? "text-destructive" : "text-foreground"}`}
          >
            {counts.err}
          </div>
        </div>
      </div>
      <div
        ref={scroller}
        className="h-[360px] overflow-y-auto bg-background/40 p-5 font-mono text-[12px] leading-relaxed"
      >
        {events.length === 0 && (
          <div className="grid h-full place-items-center text-center text-muted-foreground">
            <div>
              <div className="font-serif text-2xl text-foreground/80">
                {run ? "Waiting for events…" : "Stream is quiet."}
              </div>
              <p className="mt-2 max-w-xs text-[11px]">
                {run
                  ? "The orchestrator will emit status and log frames as the agent works."
                  : "Start a run to open the WebSocket and stream tool activity here."}
              </p>
            </div>
          </div>
        )}
        {events.map((ev, i) => {
          if (ev.type === "status") {
            return (
              <div
                key={i}
                className="my-1 flex items-center gap-2 border-l-2 border-warning/60 pl-3 text-warning"
              >
                <Dot tone="warning" pulse={false} /> status: {ev.status}
              </div>
            );
          }
          const tone =
            ev.level === "error"
              ? "text-destructive"
              : ev.level === "warning"
                ? "text-warning"
                : "text-foreground/90";
          return (
            <div key={i} className="grid grid-cols-[48px_60px_1fr] gap-3">
              <span className="text-muted-foreground">
                {String(ev.sequence ?? i + 1).padStart(3, "0")}
              </span>
              <span className="text-primary/80">{ev.level ?? "info"}</span>
              <span className={tone}>{ev.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Artifacts & draft ─────────────────────────────────────────────────────

/**
 * Figures, code, and the draft paper produced by a run.
 *
 * `exportApproved` gates the download controls: artifacts are viewable while a
 * run is in progress, but nothing can be exported until gate G4 clears in
 * `FinalExport` below. See `artifactUrl` in lib/api.ts for how each artifact's
 * URL is resolved — the backend can describe one in four different ways.
 */
export function ArtifactsAndDraft({
  run,
  exportApproved,
}: {
  run: RunOut | null;
  exportApproved: boolean;
}) {
  const artifacts = run?.artifacts ?? [];
  const figures = artifacts.filter((a) => a.kind === "figure");
  const others = artifacts.filter((a) => a.kind !== "figure");
  const draft = run?.draft_markdown ?? "";
  const draftWords = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="deliverables · gate g2"
        title="Artifacts & draft manuscript"
        subtitle="Every figure, log, and file the run produced — plus the working draft the reviewer will read."
        meta={
          <>
            <MetaChip tone={run ? "info" : "muted"}>
              {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}
            </MetaChip>
            <MetaChip>{draftWords ? `${draftWords} words` : "no draft"}</MetaChip>
            <MetaChip tone={exportApproved ? "success" : "warning"}>
              {exportApproved ? "exports unlocked" : "exports locked · G3"}
            </MetaChip>
          </>
        }
      />
      <div className="grid grid-cols-3 gap-px bg-panel-border">
        <div className="bg-panel p-4">
          <div className="mono-label">actual cost</div>
          <div className="mt-1 font-mono text-[15px] text-foreground">
            ${(run?.actual_cost ?? 0).toFixed(2)}
          </div>
        </div>
        <div className="bg-panel p-4">
          <div className="mono-label">files</div>
          <div className="mt-1 font-mono text-[15px] text-foreground">{others.length}</div>
        </div>
        <div className="bg-panel p-4">
          <div className="mono-label">figures</div>
          <div className="mt-1 font-mono text-[15px] text-foreground">{figures.length}</div>
        </div>
      </div>
      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-5">
          <div>
            <div className="mono-label mb-2">files</div>
            <div className="flex flex-wrap gap-2">
              {others.length === 0 && (
                <span className="font-mono text-[11px] text-muted-foreground">No files yet.</span>
              )}
              {others.map((a, i) => {
                const url = artifactUrl(a);
                const locked = !exportApproved;
                const cls =
                  "inline-flex items-center gap-2 rounded-full border border-panel-border bg-background/60 px-3 py-1 font-mono text-[11px] text-foreground";
                const tag = (
                  <>
                    <span className="text-muted-foreground">{a.kind}:</span> {a.name}
                    {locked && <span className="text-warning">· locked</span>}
                  </>
                );
                return url && !locked ? (
                  <a
                    key={`${a.name}-${i}`}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className={`${cls} hover:border-foreground/40`}
                  >
                    {tag}
                  </a>
                ) : (
                  <span
                    key={`${a.name}-${i}`}
                    className={`${cls} ${locked ? "opacity-70" : ""}`}
                    title={locked ? "Approve final export (Gate G3) to download" : undefined}
                  >
                    {tag}
                  </span>
                );
              })}
            </div>
            {!exportApproved && others.length > 0 && (
              <p className="mt-3 font-mono text-[10.5px] leading-relaxed text-warning">
                Downloads are locked until Gate G3 (final export) is approved below.
              </p>
            )}
          </div>
          {figures.length > 0 && (
            <div>
              <div className="mono-label mb-2">figures</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {figures.map((a, i) => {
                  const url = artifactUrl(a);
                  return (
                    <figure
                      key={`${a.name}-${i}`}
                      className="overflow-hidden rounded-md border border-panel-border bg-background/40"
                    >
                      {url ? (
                        <img
                          src={url}
                          alt={a.name}
                          className="block h-auto w-full object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <div className="grid aspect-video place-items-center font-mono text-[11px] text-muted-foreground">
                          {a.name}
                        </div>
                      )}
                      <figcaption className="border-t border-panel-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                        {a.name}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-col">
          <div className="mono-label mb-2">draft manuscript</div>
          <pre className="h-[320px] flex-1 overflow-auto rounded-md border border-panel-border bg-background/50 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/90">
            {draft || "Draft will appear here once the run produces one."}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ─── Agentic decision log ──────────────────────────────────────────────────

/**
 * The agent's step-by-step actions: which tool it called and what happened.
 *
 * The console's equivalent of the trace viewer in
 * `components/campaign/candidate-detail.tsx` — the audit trail that makes a
 * result checkable rather than merely reported.
 */
export function AgenticActionsCard({ run }: { run: RunOut | null }) {
  const actions = run?.analysis_json?.actions ?? [];
  if (!run || actions.length === 0) return null;
  const tools = new Set(actions.map((a) => a.tool ?? a.action ?? "step"));
  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="analysis · agentic trace"
        title="Decision trace"
        subtitle="Ordered tool calls the agent chose, with the reasoning and I/O behind each move."
        meta={
          <>
            <MetaChip tone="info">{actions.length} steps</MetaChip>
            <MetaChip>{tools.size} tools</MetaChip>
          </>
        }
      />
      <ol className="divide-y divide-panel-border">
        {actions.map((a, i) => (
          <li key={i} className="grid grid-cols-[56px_1fr] gap-4 px-6 py-4 font-mono text-[12px]">
            <span className="text-muted-foreground">
              #{String(a.step ?? i + 1).padStart(2, "0")}
            </span>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded-sm border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10.5px] tracking-[0.1em] text-primary">
                  {(a.tool ?? a.action ?? "step").toUpperCase()}
                </span>
                {a.reason && (
                  <span className="text-[12px] leading-snug text-foreground/85">{a.reason}</span>
                )}
              </div>
              {(a.input !== undefined || a.output !== undefined) && (
                <details className="text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">inspect i/o</summary>
                  <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-panel-border bg-background/50 p-3 whitespace-pre-wrap break-all text-foreground/80">
                    {JSON.stringify({ input: a.input, output: a.output }, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Execution results (RunPod) ────────────────────────────────────────────

/** Measured outcomes of the run: metrics the agent produced and recorded. */
export function ExecutionResultsCard({ run }: { run: RunOut | null }) {
  const exec = run?.analysis_json?.execution;
  if (!run || !exec) return null;
  const okTone: DotTone =
    exec.status === "ok" || exec.exit_code === 0
      ? "success"
      : exec.status === "error" || (exec.exit_code ?? 0) !== 0
        ? "error"
        : "warning";
  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="execution · runpod sandbox"
        title="Code execution results"
        subtitle="Sandboxed program output, cost, and duration returned by the RunPod endpoint."
        meta={<MetaChip tone={okTone}>{exec.status ?? `exit ${exec.exit_code ?? "?"}`}</MetaChip>}
      />
      <div className="grid grid-cols-2 gap-px bg-panel-border sm:grid-cols-3">
        <div className="bg-panel p-4">
          <StatTile label="exit" value={exec.exit_code ?? "—"} />
        </div>
        <div className="bg-panel p-4">
          <StatTile
            label="duration"
            value={exec.duration_ms != null ? `${exec.duration_ms} ms` : "—"}
          />
        </div>
        <div className="bg-panel p-4">
          <StatTile label="cost" value={exec.cost != null ? `$${exec.cost.toFixed(4)}` : "—"} />
        </div>
      </div>
      <div className="space-y-4 p-6">
        {exec.stdout && (
          <div>
            <div className="mono-label">stdout</div>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-panel-border bg-background/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {exec.stdout}
            </pre>
          </div>
        )}
        {exec.stderr && (
          <div>
            <div className="mono-label">stderr</div>
            <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-destructive/40 bg-destructive/5 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
              {exec.stderr}
            </pre>
          </div>
        )}
        {exec.results !== undefined && (
          <div>
            <div className="mono-label">results.json</div>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-panel-border bg-background/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {typeof exec.results === "string"
                ? exec.results
                : JSON.stringify(exec.results, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Reviewer panel ────────────────────────────────────────────────────────

// ─── Review ────────────────────────────────────────────────────────────────

/**
 * Automated review findings for the completed run.
 *
 * These are the machine checks a human reviewer reads before approving the
 * export — the same findings surfaced by `listReviews` in lib/api.ts.
 */
