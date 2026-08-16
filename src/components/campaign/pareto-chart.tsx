// Pareto frontier. Quality against cost, with
// non-dominated candidates highlighted and connected.
//
// ===========================================================================
// THE CONCEPT (worth understanding before the code)
// ===========================================================================
// You cannot rank candidates on one number when they trade off against each
// other. A candidate scoring 0.95 for $40 is not straightforwardly better than
// one scoring 0.91 for $3 — it depends what you are willing to pay.
//
// A candidate is DOMINATED when some other candidate beats it on BOTH axes:
// cheaper AND better. A dominated candidate is never the right choice, whatever
// your budget, because something strictly better exists.
//
// The remaining ones — the NON-DOMINATED set — form the Pareto frontier. Those
// are the only genuine options, and choosing between them is a judgement call
// about budget, not a question the data can settle. This chart draws that
// frontier so the trade-off is visible.
//
// The first of three Recharts charts in this folder (see also progress-curve.tsx
// and failure-taxonomy.tsx). Recharts builds charts declaratively out of
// components — <XAxis>, <Scatter>, <Line> — rather than through imperative
// drawing calls, so a chart reads much like ordinary JSX.

import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { FrontierPoint } from "@/lib/api";
import { CHART_COLORS, Chip, EmptyState, Panel, PanelHead, fmtNum } from "./primitives";

export function ParetoChart({ points }: { points: FrontierPoint[] }) {
  // `useNavigate` gives an imperative navigation function, for moving between
  // pages from an event handler rather than from a clicked <Link>. Needed here
  // because the click target is a chart point drawn in SVG, which cannot be
  // wrapped in an anchor.
  const navigate = useNavigate();

  // One `useMemo` returning FOUR derived values via destructuring, rather than
  // four separate memos. They all depend on the same `[points]` input, so
  // computing them together keeps the dependency in one place.
  const { dominated, frontier, qualityLabel, costLabel } = useMemo(() => {
    const frontier = points
      // The backend has already worked out which points are dominated; this
      // only splits them into two series so they can be styled differently.
      .filter((p) => !p.dominated)
      // Sorting by cost is REQUIRED, not cosmetic. The <Line> below connects
      // points in array order, so an unsorted array would draw a zig-zag
      // scribble instead of a frontier. `.filter()` returns a fresh array so
      // sorting it in place is safe — contrast leaderboard-table.tsx, where the
      // array is a prop and must be copied first.
      .sort((a, b) => a.cost - b.cost);
    return {
      dominated: points.filter((p) => p.dominated),
      frontier,
      // Axis labels come FROM THE DATA, with fallbacks. The backend can measure
      // quality differently per campaign (accuracy, F1, perplexity), so the
      // chart names whatever it was actually given rather than assuming.
      qualityLabel: points[0]?.quality_label ?? "quality",
      costLabel: points[0]?.cost_label ?? "cost",
    };
  }, [points]);

  return (
    <Panel>
      <PanelHead
        kicker="evaluation · pareto"
        title="Quality vs cost frontier"
        subtitle="“Best” is a tradeoff, not one number. Highlighted points are non-dominated: nothing is both cheaper and better."
        meta={<Chip tone="success">{frontier.length} on frontier</Chip>}
      />
      {points.length === 0 ? (
        <EmptyState label="no frontier yet" hint="Needs at least one scored candidate with a cost vector." />
      ) : (
        // A FIXED PIXEL HEIGHT on the wrapper is mandatory for Recharts.
        // `ResponsiveContainer` sizes itself to its parent, so if the parent
        // height is `auto` the container computes 0 and the chart silently
        // renders nothing. This is the single most common Recharts problem.
        <div className="h-[320px] px-3 py-5">
          <ResponsiveContainer width="100%" height="100%">
            {/* `ComposedChart` allows mixed mark types in one plot — the two
                <Scatter> series and the <Line> below. A plain <ScatterChart>
                could not also draw the connecting line. */}
            <ComposedChart margin={{ top: 8, right: 20, bottom: 16, left: 0 }}>
              {/* Dashed grid: "2 4" means a 2px dash then a 4px gap, which
                  keeps the grid faint enough to stay behind the data. */}
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 4" />
              <XAxis
                // `type="number"` is essential for a scatter plot. Recharts
                // defaults to a CATEGORY axis, which spaces points evenly by
                // index and would destroy the meaning of the positions. A
                // numeric axis places each point at its true value.
                type="number"
                dataKey="cost"
                name={costLabel}
                // Axis styling uses the CHART_COLORS tokens so the chart
                // follows the theme — see the note in primitives.tsx.
                tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                stroke={CHART_COLORS.grid}
                label={{
                  value: costLabel,
                  position: "insideBottom",
                  offset: -8,
                  fill: CHART_COLORS.muted,
                  fontSize: 10,
                }}
              />
              <YAxis
                type="number"
                dataKey="quality"
                name={qualityLabel}
                tick={{ fill: CHART_COLORS.muted, fontSize: 11, fontFamily: "var(--font-mono)" }}
                stroke={CHART_COLORS.grid}
                // Explicit width reserves room for the tick labels; too little
                // and the numbers are clipped at the left edge.
                width={54}
                label={{
                  value: qualityLabel,
                  // Rotated to read bottom-to-top, the convention for y-axis
                  // labels.
                  angle: -90,
                  position: "insideLeft",
                  fill: CHART_COLORS.muted,
                  fontSize: 10,
                }}
              />
              {/* ZAxis controls the third dimension — here, point SIZE. The
                  range [60, 60] pins every point to the same size, since size
                  carries no meaning in this chart. Without it Recharts would
                  scale points by a data value, implying a relationship that
                  does not exist. */}
              <ZAxis range={[60, 60]} />
              <Tooltip
                cursor={{ stroke: CHART_COLORS.grid }}
                // Recharts renders the tooltip outside Tailwind's reach, so it
                // is styled with inline CSS variables to match the panels.
                contentStyle={{
                  background: "var(--panel)",
                  border: "1px solid var(--panel-border)",
                  borderRadius: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
                // Returns [displayedValue, displayedName] — this is what routes
                // the raw numbers through `fmtNum` so the tooltip shows "0.912"
                // rather than "0.9123456789".
                formatter={(value, name) => [fmtNum(value as number), String(name)]}
                // Suppresses the tooltip's header line, which for a scatter
                // plot would show a meaningless index.
                labelFormatter={() => ""}
              />
              {/* TWO SEPARATE SERIES over the same axes — this is how the
                  visual distinction is achieved. Dominated points are drawn
                  muted and semi-transparent so they recede; frontier points are
                  drawn in the success colour so they stand out. Order matters:
                  dominated is declared first, so frontier points paint on top
                  where they overlap. */}
              <Scatter
                name="dominated"
                data={dominated}
                fill={CHART_COLORS.muted}
                fillOpacity={0.5}
                onClick={(p: unknown) => {
                  // Typed `unknown` because Recharts hands back a loosely-typed
                  // payload, so the cast is unavoidable here.
                  const id = (p as FrontierPoint)?.candidate_id;
                  // `void` marks the floating promise as deliberately
                  // unawaited — navigation is fire-and-forget.
                  if (id) void navigate({ to: "/candidates/$id", params: { id: String(id) } });
                }}
              />
              <Scatter
                name="frontier"
                data={frontier}
                fill={CHART_COLORS.success}
                onClick={(p: unknown) => {
                  const id = (p as FrontierPoint)?.candidate_id;
                  if (id) void navigate({ to: "/candidates/$id", params: { id: String(id) } });
                }}
              />
              {/* The frontier line itself, connecting the non-dominated points
                  in cost order (hence the sort above). */}
              <Line
                data={frontier}
                // "linear" draws straight segments. A smoothed curve would be
                // actively misleading here — it would imply candidates exist at
                // the interpolated positions, which they do not.
                type="linear"
                dataKey="quality"
                stroke={CHART_COLORS.success}
                // Dashed for the same reason: the line indicates a trend
                // between measured points, not a continuous set of options.
                strokeDasharray="4 4"
                strokeWidth={1.5}
                // The <Scatter> above already draws these points; letting the
                // line draw its own would double up and blur the markers.
                dot={false}
                // Animation off so live-polled updates redraw instantly rather
                // than replaying a transition every few seconds.
                isAnimationActive={false}
                legendType="none"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      {/* The click affordance is not otherwise discoverable — SVG points give
          no hover cue that they are interactive — so it is stated in words. */}
      <div className="border-t border-panel-border px-6 py-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
        click a point to open the candidate
      </div>
    </Panel>
  );
}
