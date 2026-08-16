// Agent evaluation tile. Judges the searcher,
// not the artifact: hit rate, invalid rate, time-to-best, useful regressions.
//
// The smallest component in this folder, and a clean example of the shape most
// of them take: accept data as a prop, arrange primitives, render. No state, no
// fetching, no effects.
//
// The DOMAIN idea is the interesting part here. Everywhere else in the app
// measures how good the best candidate is. This tile measures how good the
// SEARCH PROCESS is, which is a different question — a search can stumble onto
// one excellent result by luck while being a poor searcher overall, and a good
// searcher can be working on a genuinely hard problem. Separating the two is
// what lets you tell "the agent is bad" from "the problem is hard".

import type { AgentMetrics } from "@/lib/api";
import { Panel, PanelHead, Stat, fmtNum } from "./primitives";

export function AgentMetricsTile({ metrics }: { metrics: AgentMetrics | null | undefined }) {
  // Accepting `null | undefined` rather than requiring the data means the
  // caller can render this tile before metrics have loaded. Every read below
  // uses `?.`, so it degrades to em dashes instead of crashing — the component
  // handles its own loading state.

  // A local helper, defined inside the component because it is used nowhere
  // else. Converts a 0–1 ratio into a percentage string: 0.42 becomes "42%".
  // Rounding is right for a headline metric — "42%" communicates as well as
  // "41.7385%" and reads far better.
  const pct = (v: number | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

  return (
    <Panel>
      <PanelHead
        kicker="agent evaluation"
        // Section titles here are phrased as plain questions rather than jargon
        // ("Is the searcher any good?"), which does a lot of the explaining.
        title="Is the searcher any good?"
        subtitle="These four numbers grade the proposer itself — independent of how strong the best candidate happens to be."
      />
      {/* RESPONSIVE GRID, and a good illustration of Tailwind's mobile-first
          breakpoints. Unprefixed classes apply at ALL sizes; a prefix means
          "at this width and above". So the columns go:
            (default, phones)  1 column
            sm: (≥640px)       2 columns
            xl: (≥1280px)      4 columns
          Reading it as progressive enhancement — start with the narrowest
          layout, add columns as space allows — is the mental model. */}
      <div className="grid gap-3 px-6 py-5 sm:grid-cols-2 xl:grid-cols-4">
        {/* Each Stat pairs a metric with a `hint` translating the jargon.
            "hit rate" means little on its own; "proposals that improved" is
            immediately clear. Cheap to add, and it is what makes a dense
            metrics panel readable by someone who did not build it. */}
        <Stat label="hit rate" value={pct(metrics?.hit_rate)} hint="proposals that improved" />
        {/* A high invalid rate means the agent is producing edits that do not
            even run — a different failure from producing edits that run badly.
            See `failure-taxonomy.tsx` for the breakdown of why. */}
        <Stat label="invalid rate" value={pct(metrics?.invalid_rate)} hint="failed to evaluate" />
        <Stat
          label="time to best"
          // Not a percentage, so it formats separately: one decimal place and
          // an "m" suffix for minutes.
          value={metrics?.time_to_best_minutes != null ? `${fmtNum(metrics.time_to_best_minutes, 1)}m` : "—"}
          hint="wall clock to incumbent"
        />
        <Stat
          label="useful regressions"
          value={pct(metrics?.useful_regression_rate)}
          // The subtlest metric of the four: a candidate that scored WORSE but
          // whose result informed a later winner. A search that only ever
          // improves is likely exploring too timidly, so some proportion of
          // productive failures is a healthy sign rather than a bad one.
          hint="losses that seeded a win"
        />
      </div>
    </Panel>
  );
}
