// Progress curve. Best-so-far score over evaluated candidates, with kept /
// discarded / invalid candidates styled distinctly so stagnation is visible at
// a glance.
//
// The question this chart answers: IS THE SEARCH STILL MAKING PROGRESS?
//
// The step line only ever rises — it tracks the best score found so far. A long
// flat stretch means many candidates have been evaluated without improving on
// the incumbent, which is the signal to stop and rethink rather than keep
// spending. Scattered markers underneath show what was tried in the meantime.
//
// The most interesting code here is the `useMemo` running-maximum, which is a
// good example of transforming raw records into chart-ready data.

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CandidateOut } from "@/lib/api";
import { CHART_COLORS, EmptyState, Panel, PanelHead, Chip, fmtNum } from "./primitives";

/**
 * One point on the chart.
 *
 * The three status fields deserve explanation, because the design looks odd
 * until you know the Recharts idiom. `kept`, `discarded`, and `invalid` are the
 * SAME score value routed into whichever field matches the candidate's status,
 * with the other two set to null.
 *
 * Recharts skips null values, so each <Scatter> below renders only the points
 * belonging to its own series. That is how three differently-shaped marker sets
 * are drawn from one array, without splitting it into three arrays that would
 * then need to stay aligned on the x-axis.
 */
type Point = {
  idx: number;
  score: number | null;
  best: number | null;
  kept: number | null;
  discarded: number | null;
  invalid: number | null;
  id: number;
  family: string;
  status: string;
};

export function ProgressCurve({ candidates }: { candidates: CandidateOut[] }) {
  const data = useMemo<Point[]>(() => {
    // Copy before sorting — `.sort()` mutates, and `candidates` is a prop. Same
    // hazard explained at length in leaderboard-table.tsx.
    //
    // The comparator uses `||` for a TIE-BREAK: compare by iteration, and when
    // that yields 0 (equal), fall through to comparing ids. This guarantees a
    // stable, deterministic order even when several candidates share an
    // iteration — without it the x-axis could reshuffle between renders.
    const evaluated = [...candidates].sort((a, b) => a.iteration - b.iteration || a.id - b.id);

    // A RUNNING MAXIMUM accumulated across the `.map()` below. Declaring `best`
    // outside the callback is what lets each iteration see the previous value —
    // this is a fold expressed as a map, which is why the map has a side effect
    // on an outer variable. It works only because the array is now sorted, so
    // "previous" genuinely means earlier in the search.
    let best: number | null = null;

    return evaluated.map((c, i) => {
      // Update the incumbent BEFORE building the point, so a candidate that
      // sets a new best is recorded at its own new value rather than the
      // previous one. `best == null` handles the first scored candidate.
      if (c.score != null && (best == null || c.score > best)) best = c.score;
      return {
        // 1-based, because "candidate #1" reads better than "#0" on an axis.
        idx: i + 1,
        id: c.id,
        family: c.edit_family,
        status: c.status,
        score: c.score,
        best,
        // The null-routing described on the `Point` type above.
        kept: c.status === "kept" ? c.score : null,
        discarded: c.status === "discarded" ? c.score : null,
        // Invalid candidates often have NO score — they failed before
        // producing one. Falling back to `best` plots them on the incumbent
        // line so they remain visible; `?? 0` is the last resort when nothing
        // has scored yet. Without this they would be dropped from the chart
        // entirely and the failures would be invisible.
        invalid: c.status === "invalid" ? (c.score ?? best ?? 0) : null,
      };
    });
  }, [candidates]);

  // The final point's `best` is the overall best, since the value only ever
  // climbs. Reading the last element is cheaper than a second pass over the
  // array.
  const best = data.length ? data[data.length - 1].best : null;

  return (
    <Panel>
      <PanelHead
        kicker="evaluation · progress"
        title="Best-so-far score"
        subtitle="Every evaluated candidate in search order. The step line is the incumbent; markers show whether each proposal was kept, discarded, or invalid."
        meta={<Chip tone="success">best {fmtNum(best)}</Chip>}
      />
      {data.length === 0 ? (
        <EmptyState label="no evaluated candidates yet" hint="The curve appears once the proposer completes its first evaluation." />
      ) : (
        // Fixed height, required by ResponsiveContainer — see pareto-chart.tsx.
        <div className="h-[300px] px-3 py-5">
          <ResponsiveContainer width="100%" height="100%">
            {/* Unlike the Pareto chart, `data` is passed to the chart itself
                rather than to each series, because all four series share one
                array here. */}
            <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              {/* `vertical={false}` draws horizontal gridlines only. Vertical
                  lines would add clutter without helping — the x-axis is an
                  ordinal sequence, so precise horizontal positions do not need
                  reading off. */}
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="idx"
                // No `type="number"` here, unlike the Pareto chart. The default
                // category axis is correct for an evenly-spaced sequence.
                tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                stroke={CHART_COLORS.grid}
                label={{
                  value: "candidates evaluated",
                  position: "insideBottom",
                  offset: -4,
                  fill: CHART_COLORS.muted,
                  fontSize: 10,
                }}
              />
              <YAxis
                tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                stroke={CHART_COLORS.grid}
                width={54}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--panel)",
                  border: "1px solid var(--panel-border)",
                  borderRadius: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
                labelFormatter={(v) => `candidate #${v}`}
                // The third argument, `item`, carries the FULL data point via
                // `item.payload` — not just the single plotted value. That is
                // what allows the tooltip to show the edit family and candidate
                // id alongside the score, turning a bare number into something
                // you can act on.
                formatter={(value, name, item) => {
                  const p = item.payload as Point;
                  if (name === "best") return [fmtNum(value as number), "best-so-far"];
                  return [`${fmtNum(value as number)} · ${p.family} · c${p.id}`, p.status];
                }}
              />
              {/* `type="stepAfter"` is the load-bearing choice in this chart.
                  A smooth or straight line would imply the score improved
                  gradually between candidates; in reality it holds flat and
                  then jumps the moment a better candidate appears. A step line
                  is the honest shape for a running maximum. */}
              <Line
                type="stepAfter"
                dataKey="best"
                stroke={CHART_COLORS.primary}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              {/* Three series over the same data array, each picking up only
                  its non-null field. Note they differ by SHAPE as well as
                  colour — circle, diamond, cross — so the chart stays readable
                  in greyscale and for colour-blind viewers. Encoding meaning by
                  colour alone is a common accessibility failure. */}
              <Scatter dataKey="kept" fill={CHART_COLORS.success} shape="circle" />
              <Scatter dataKey="discarded" fill={CHART_COLORS.muted} shape="diamond" />
              <Scatter dataKey="invalid" fill={CHART_COLORS.danger} shape="cross" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      {/* A hand-rolled legend rather than Recharts' <Legend>, for full control
          over placement and styling. */}
      <div className="flex flex-wrap gap-4 border-t border-panel-border px-6 py-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
        <Legend color={CHART_COLORS.primary} label="incumbent" />
        <Legend color={CHART_COLORS.success} label="kept" />
        <Legend color={CHART_COLORS.muted} label="discarded" />
        <Legend color={CHART_COLORS.danger} label="invalid" />
      </div>
    </Panel>
  );
}

/**
 * A single legend swatch. Defined at the bottom of the file and not exported —
 * a private helper for this module only.
 *
 * Note it uses an inline `style` rather than a Tailwind class, because the
 * colour arrives as a runtime string. Tailwind cannot generate a class from a
 * dynamic value (see the note in primitives.tsx `Dot`), so inline style is the
 * correct tool here rather than a workaround.
 */
function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-4 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
