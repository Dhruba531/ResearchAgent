// Failure taxonomy. Breakdown of why
// candidates died, plus failure type by iteration.
//
// Two charts side by side, answering two different questions:
//   LEFT  (horizontal bars)  — WHAT kinds of failure happened, in total?
//   RIGHT (stacked columns)  — WHEN did they happen, across the search?
//
// The pairing is the point. Totals alone hide a trend: twenty syntax errors
// spread evenly is a constant baseline, whereas twenty clustered in the last
// few iterations means the proposer has recently drifted into producing broken
// code. The subtitle states this reading explicitly.
//
// The third and last Recharts file in this folder. See pareto-chart.tsx for the
// Recharts basics; this one adds stacked bars and a horizontal layout.

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CandidateOut } from "@/lib/api";
import { CHART_COLORS, Chip, EmptyState, Panel, PanelHead } from "./primitives";

// The failure categories, in a fixed order so colours and legend entries stay
// stable between renders. Roughly ordered from "the code was broken" to "the
// results were untrustworthy":
//   syntax/import     — did not parse or could not resolve its dependencies
//   shape             — tensor dimensions did not line up
//   oom               — ran out of memory
//   nan               — training diverged into NaN
//   timeout           — exceeded its wall-clock budget
//   leakage           — test data contaminated training: the result is a lie
//   metric_integrity  — the reported metric could not be trusted
// The last two matter most: those candidates may have SCORED WELL while being
// invalid, which is exactly the failure mode automated search is prone to.
const KINDS = [
  "syntax",
  "import",
  "shape",
  "oom",
  "nan",
  "timeout",
  "leakage",
  "metric_integrity",
];

// Per-kind colours for the stacked chart. Note `color-mix(in oklab, ...)` —
// CSS's native colour blending, used here to derive extra distinguishable hues
// from the existing theme tokens rather than hard-coding new ones. Blending in
// the oklab space keeps perceived brightness even, which sRGB mixing does not.
// The result still follows the theme, since the inputs are variables.
const COLORS: Record<string, string> = {
  syntax: "var(--destructive)",
  import: "var(--warning)",
  shape: "var(--accent)",
  oom: "color-mix(in oklab, var(--accent) 60%, var(--foreground))",
  nan: "var(--primary)",
  timeout: "var(--success)",
  leakage: "color-mix(in oklab, var(--primary) 55%, var(--accent))",
  metric_integrity: "var(--muted-foreground)",
};

export function FailureTaxonomy({ candidates }: { candidates: CandidateOut[] }) {
  const { totals, byIteration, invalidCount } = useMemo(() => {
    // Require BOTH conditions: invalid status and a recorded reason. An invalid
    // candidate with no `failure_kind` cannot be categorised, so including it
    // would produce a phantom bar with no label.
    const failed = candidates.filter((c) => c.status === "invalid" && c.failure_kind);

    // Count per kind, then drop the empty ones. Mapping over `KINDS` rather
    // than over the data guarantees a consistent order regardless of which
    // failure happened first; the trailing `.filter` then removes categories
    // that never occurred, so the chart shows no empty rows.
    const totals = KINDS.map((kind) => ({
      kind,
      count: failed.filter((c) => c.failure_kind === kind).length,
    })).filter((t) => t.count > 0);

    // Unique iteration numbers, ascending. Set for deduplication, `Array.from`
    // to get something mappable — the same idiom as the family filter in
    // leaderboard-table.tsx. The explicit numeric sort is necessary because
    // `.sort()` defaults to STRING comparison, which would order 10 before 2.
    const iters = Array.from(new Set(failed.map((c) => c.iteration))).sort((a, b) => a - b);

    // Reshape into one row per iteration with a column per failure kind —
    // the "wide" format Recharts needs for stacked bars:
    //   { iteration: 3, syntax: 2, import: 0, shape: 1, ... }
    const byIteration = iters.map((it) => {
      const row: Record<string, number> = { iteration: it };
      // Every kind is written, including zeros. Recharts needs the key present
      // on every row for a stack to render consistently.
      for (const k of KINDS) {
        row[k] = failed.filter((c) => c.iteration === it && c.failure_kind === k).length;
      }
      return row;
    });

    return { totals, byIteration, invalidCount: failed.length };
  }, [candidates]);
  // Performance note: the nested `.filter()` inside `.map()` makes this
  // O(kinds × iterations × candidates). Fine at these sizes — a few hundred
  // candidates — and the memo means it only reruns when the data changes. If
  // campaigns grew to tens of thousands, a single grouping pass would be the
  // fix.

  // Only the kinds that actually occurred get a <Bar>, so the legend lists real
  // categories instead of all eight every time. Computed outside the memo since
  // it is a trivial derivation from `totals`.
  const activeKinds = KINDS.filter((k) => totals.some((t) => t.kind === k));

  return (
    <Panel>
      <PanelHead
        kicker="diagnostics · failure taxonomy"
        title="Why candidates die"
        subtitle="A rising invalid rate usually means the proposer drifted, not that the problem got harder."
        // The chip flips colour on the data: green when there are no failures,
        // red as soon as there are. Cheap, and it makes the panel readable at a
        // glance without reading any numbers.
        meta={<Chip tone={invalidCount ? "danger" : "success"}>{invalidCount} invalid</Chip>}
      />
      {invalidCount === 0 ? (
        <EmptyState label="no failures recorded" hint="Invalid candidates are bucketed here as they occur." />
      ) : (
        // Stacks on mobile, side by side from `lg` (≥1024px) upward.
        <div className="grid gap-6 px-3 py-5 lg:grid-cols-2">
          {/* ── LEFT: totals by kind ─────────────────────────────────────── */}
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              {/* `layout="vertical"` makes the bars HORIZONTAL — the naming is
                  famously confusing. It describes the axis orientation, not the
                  bar direction. This layout is the right choice here because
                  category names like "metric_integrity" are long, and reading
                  them horizontally beats rotating them under a column chart. */}
              <BarChart data={totals} layout="vertical" margin={{ left: 24, right: 16 }}>
                {/* `horizontal={false}` leaves only vertical gridlines — the
                    ones that help compare bar lengths in this orientation. */}
                <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 4" horizontal={false} />
                {/* In a vertical layout the axes swap roles: X carries the
                    numeric count, Y carries the categories. */}
                <XAxis
                  type="number"
                  // Counts are whole numbers; without this Recharts may label
                  // ticks 0.5, 1.5 — meaningless for "number of failures".
                  allowDecimals={false}
                  tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  stroke={CHART_COLORS.grid}
                />
                <YAxis
                  type="category"
                  dataKey="kind"
                  // Generous width so "metric_integrity" is not clipped.
                  width={110}
                  tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  stroke={CHART_COLORS.grid}
                />
                <Tooltip
                  // A translucent hover band. `color-mix` with `transparent`
                  // gives a tint that works over any theme background.
                  cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }}
                  contentStyle={{
                    background: "var(--panel)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                />
                {/* `radius` is [topLeft, topRight, bottomRight, bottomLeft], so
                    this rounds only the right-hand end — the growing end of a
                    horizontal bar. The flat left edge keeps bars aligned
                    against the axis. */}
                <Bar dataKey="count" fill={CHART_COLORS.danger} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ── RIGHT: failures over time, stacked by kind ───────────────── */}
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byIteration} margin={{ left: 0, right: 16 }}>
                <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="iteration"
                  tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  stroke={CHART_COLORS.grid}
                />
                <YAxis
                  allowDecimals={false}
                  width={36}
                  tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  stroke={CHART_COLORS.grid}
                />
                <Tooltip
                  cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }}
                  contentStyle={{
                    background: "var(--panel)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                />
                {/* Recharts' own <Legend> here, rather than the hand-rolled one
                    in progress-curve.tsx — worthwhile because the series are
                    generated dynamically and it labels them automatically. */}
                <Legend wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 10 }} />
                {/* DYNAMICALLY GENERATED SERIES: one <Bar> per failure kind
                    present in the data.

                    `stackId="f"` is what stacks them. Bars sharing a stackId
                    are piled on top of each other rather than drawn side by
                    side, so each column's total height is the failures in that
                    iteration and each coloured segment is one kind. Remove the
                    stackId and you would get eight thin bars per iteration. */}
                {activeKinds.map((k) => (
                  <Bar key={k} dataKey={k} stackId="f" fill={COLORS[k]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Panel>
  );
}
