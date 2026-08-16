// Automated reviewer findings raised against the draft.

import { useMemo } from "react";
import { type ReviewFindingOut } from "@/lib/api";
import { BentoHead, Dot, DotTone, MetaChip } from "./primitives";
import { RunSetupCard } from "./gates";
import { StatusTimeline, TimelineDetailSheet, TimelineEvent, toneStyles } from "./timeline";

export function ReviewerPanel({ findings }: { findings: ReviewFindingOut[] }) {
  const grouped = useMemo(() => {
    const bag = new Map<string, ReviewFindingOut[]>();
    for (const f of findings) {
      const list = bag.get(f.category) ?? [];
      list.push(f);
      bag.set(f.category, list);
    }
    return Array.from(bag.entries());
  }, [findings]);

  const severityCounts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      const s = (f.severity ?? "low").toLowerCase();
      if (s === "high") c.high++;
      else if (s === "medium") c.medium++;
      else c.low++;
    }
    return c;
  }, [findings]);

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="review · gate g2 verdicts"
        title="Reviewer findings"
        subtitle="Automated reviewers score the run across methods, statistics, novelty, and safety. Each card groups findings by category with the worst severity surfaced."
        meta={
          findings.length ? (
            <>
              {severityCounts.high > 0 && (
                <MetaChip tone="error">{severityCounts.high} high</MetaChip>
              )}
              {severityCounts.medium > 0 && (
                <MetaChip tone="warning">{severityCounts.medium} medium</MetaChip>
              )}
              {severityCounts.low > 0 && (
                <MetaChip tone="success">{severityCounts.low} low</MetaChip>
              )}
            </>
          ) : (
            <MetaChip>awaiting run</MetaChip>
          )
        }
      />
      {findings.length === 0 ? (
        <div className="grid place-items-center px-6 py-12 text-center">
          <div>
            <div className="font-serif text-2xl text-foreground/80">No reviewer findings yet.</div>
            <p className="mx-auto mt-2 max-w-sm text-[13px] text-muted-foreground">
              Verdicts appear here after a run completes and the reviewer chain finishes scoring.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-px bg-panel-border md:grid-cols-2 xl:grid-cols-3">
          {grouped.map(([category, items]) => {
            const worst = items.reduce<string>(
              (acc, f) =>
                f.severity === "high"
                  ? "high"
                  : acc === "high"
                    ? "high"
                    : f.severity === "medium"
                      ? "medium"
                      : acc,
              "low",
            );
            const tone: DotTone =
              worst === "high" ? "error" : worst === "medium" ? "warning" : "success";
            return (
              <div key={category} className="bg-panel p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="mono-label">category</div>
                    <h3 className="mt-1 font-serif text-2xl leading-tight text-foreground">
                      {category}
                    </h3>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.15em] ${
                      tone === "error"
                        ? "border-destructive/50 text-destructive"
                        : tone === "warning"
                          ? "border-warning/50 text-warning"
                          : "border-primary/40 text-primary"
                    }`}
                  >
                    <Dot tone={tone} pulse={false} /> {worst.toUpperCase()}
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  {items.map((f, i) => (
                    <div
                      key={i}
                      className="border-t border-panel-border pt-3 first:border-t-0 first:pt-0"
                    >
                      <p className="text-sm leading-relaxed text-foreground/90">{f.finding}</p>
                      {f.suggested_fix && (
                        <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                          fix: {f.suggested_fix}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Status timeline ───────────────────────────────────────────────────────
//
// The vertical progress rail down the page: every gate and state change in the
// run's life, newest at the bottom. At ~700 lines this is the second-largest
// block in the file after RunSetupCard.
//
// Read it in three parts:
//   1. `TimelineEvent` + `toneStyles` — the data shape and its colour lookup
//   2. `StatusTimeline`  — derives the event list from the current run state
//   3. `TimelineDetailSheet` — the side panel for one expanded event

// Note this is a THIRD tone vocabulary in the codebase, distinct from `DotTone`
// above and `Tone` in campaign/primitives.tsx. It adds "pending" and "active",
// which the others have no need for.
