// The campaign dashboard — the page that ties the whole `campaign/` component
// folder together. Every chart you commented through earlier is assembled here.
//
// Worth reading for three route-level concepts not seen elsewhere:
//   • `beforeLoad` — an auth guard that runs BEFORE the page renders
//   • `$id`        — a dynamic URL segment, read via `Route.useParams()`
//   • a WebSocket subscription managed by `useEffect`, layered on top of
//     TanStack Query's polling
//
// The data flow is worth holding in mind: polling (campaign-queries.ts) is the
// baseline, and the WebSocket is an accelerator that invalidates caches when
// something actually happens. If the socket fails, the page still updates —
// just more slowly. That graceful degradation is deliberate.

import { createFileRoute, isRedirect, Link, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "sonner";
import { WorkspaceTheme } from "@/components/workspace-theme";
import { me, openSearchTrace, type SearchTraceEvent } from "@/lib/api";
import {
  campaignKeys,
  isLive,
  useCampaign,
  useCandidates,
  useFrontier,
  useLeaderboard,
} from "@/lib/campaign-queries";
import { AgentMetricsTile } from "@/components/campaign/agent-metrics";
import { FailureTaxonomy } from "@/components/campaign/failure-taxonomy";
import { LeaderboardTable } from "@/components/campaign/leaderboard-table";
import { LineageGraph } from "@/components/campaign/lineage-graph";
import { ParetoChart } from "@/components/campaign/pareto-chart";
import { ProgressCurve } from "@/components/campaign/progress-curve";
import { SearchController } from "@/components/campaign/search-controller";
import { Chip, EmptyState, Panel, PanelHead, StatusPill } from "@/components/campaign/primitives";

// `$id` in the filename is a DYNAMIC SEGMENT — it matches any value, so this
// one file serves /campaigns/1, /campaigns/42, and so on. The captured value is
// read with `Route.useParams()` below.
export const Route = createFileRoute("/campaigns/$id")({
  // Disables server-side rendering for this route. Correct here: the page is
  // auth-gated, entirely live, and its data is user-specific, so there is
  // nothing meaningful to render on the server.
  ssr: false,

  // THE AUTH GUARD. `beforeLoad` runs before the component renders and before
  // any data loads, so an unauthenticated visitor never sees a flash of the
  // dashboard before being bounced.
  //
  // Redirecting by THROWING looks odd if you have not seen it before. TanStack
  // Router uses exceptions for control flow here — throwing a redirect aborts
  // the render immediately, which a `return` could not do.
  beforeLoad: async ({ location }) => {
    try {
      const user = await me();
      // `location.href` is passed along so the user lands back here after
      // signing in, rather than on the default page.
      if (!user) throw redirect({ to: "/auth", search: { redirect: location.href } });
    } catch (err) {
      // ESSENTIAL SUBTLETY: the redirect thrown above lands in this catch. The
      // `isRedirect` check re-throws it so it keeps propagating. Without this
      // line, the catch would swallow the redirect and convert it into the
      // fallback below — which happens to redirect too, so it would still
      // work, but by accident rather than design.
      if (isRedirect(err)) throw err;
      // A genuine error from `me()` — network failure, expired session — is
      // also treated as "not signed in". Failing closed is the right default
      // for an auth check.
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
  },
  head: () => ({
    meta: [
      { title: "Campaign dashboard — AgentLab" },
      {
        name: "description",
        content:
          "Live search campaign dashboard: progress curve, leaderboard, Pareto frontier, lineage, failure taxonomy, and agent metrics.",
      },
      { property: "og:title", content: "Campaign dashboard — AgentLab" },
      {
        property: "og:description",
        content: "Watch an autoresearch search climb: progress curve, Pareto frontier, and candidate archive.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  // Route-level error and 404 screens, overriding the app-wide ones in
  // `__root.tsx` with campaign-specific wording.
  errorComponent: ({ error }) => (
    <main className="theme-console grid min-h-screen place-items-center px-6" role="alert">
      <div className="panel max-w-md p-6 text-center">
        <p className="mono-label">campaign unavailable</p>
        <p className="mt-2 text-[13px] text-muted-foreground">{error.message}</p>
      </div>
    </main>
  ),
  notFoundComponent: () => (
    <main className="theme-console grid min-h-screen place-items-center px-6">
      <p className="font-mono text-[12px] text-muted-foreground">campaign not found</p>
    </main>
  ),
  component: CampaignDashboard,
});

function CampaignDashboard() {
  // URL params are ALWAYS strings — /campaigns/42 gives "42", not 42 — so the
  // conversion is required before passing it to the typed query hooks.
  const { id } = Route.useParams();
  const campaignId = Number(id);
  const qc = useQueryClient();

  // Four queries, and note the DEPENDENCY between them: `live` is derived from
  // the campaign, then fed to the other three so they all poll at the fast rate
  // while the search is running and relax together when it stops. See
  // `lib/campaign-queries.ts` for how the intervals work.
  const { data: campaign, isLoading, error } = useCampaign(campaignId);
  const live = isLive(campaign);
  const { data: candidates } = useCandidates(campaignId, { live });
  const { data: leaderboard } = useLeaderboard(campaignId, live);
  const { data: frontier } = useFrontier(campaignId, live);

  const [trace, setTrace] = useState<SearchTraceEvent[]>([]);
  // `useRef` holds a mutable value that does NOT trigger a re-render when it
  // changes — the right tool for a socket handle, which is infrastructure
  // rather than displayed data. Putting it in state would re-render the page
  // every time the connection changed.
  const wsRef = useRef<WebSocket | null>(null);

  // Live search-trace subscription: append events and invalidate caches so the
  // charts follow the loop without hammering the API.
  useEffect(() => {
    // Only connect while the campaign is running. A finished campaign emits
    // nothing, so an open socket would be pure overhead.
    if (!live) return;
    let ws: WebSocket | null = null;
    try {
      ws = openSearchTrace(campaignId, (ev) => {
        // `prev.slice(-400)` keeps only the last 400 events — a BOUNDED
        // BUFFER. A long-running campaign could emit tens of thousands, and
        // an unbounded array would grow until the tab ran out of memory.
        // `-400` counts from the end, so this drops the oldest.
        setTrace((prev) => [...prev.slice(-400), ev]);

        // The key line: on a meaningful event, invalidate the campaign's
        // caches so every chart refetches immediately rather than waiting out
        // its poll interval. Filtering to "evaluate" and status changes avoids
        // triggering a refetch storm on chatty log events.
        if (ev.phase === "evaluate" || ev.type === "status") {
          // Prefix matching invalidates the whole `["campaign", id, …]`
          // subtree in one call — see `useCampaignInvalidator` in
          // lib/campaign-queries.ts.
          void qc.invalidateQueries({ queryKey: ["campaign", campaignId] });
        }
      });
      wsRef.current = ws;
    } catch {
      /* socket unavailable — polling still drives the view */
      // The graceful degradation mentioned in the file header: a failed socket
      // is not an error state, because polling already keeps the page correct.
    }
    return () => {
      // Cleanup closes the socket when the campaign stops, the id changes, or
      // the page unmounts. Without it, navigating between campaigns would leak
      // a live connection each time.
      ws?.close();
      wsRef.current = null;
    };
  }, [campaignId, live, qc]);
  // ^ Re-runs when any dependency changes. `live` flipping to false is what
  //   tears the socket down; `campaignId` changing swaps to the new campaign's
  //   stream.

  if (isLoading) {
    return (
      <main className="theme-console grid min-h-screen place-items-center">
        <span className="inline-flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading campaign
        </span>
      </main>
    );
  }

  if (error || !campaign) {
    return (
      <main className="theme-console grid min-h-screen place-items-center px-6">
        <div className="panel max-w-md p-6 text-center">
          <p className="mono-label">campaign unavailable</p>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {error instanceof Error ? error.message : "The runner did not return this campaign."}
          </p>
          <Link
            to="/campaigns"
            className="mt-4 inline-block font-mono text-[12px] text-primary hover:underline"
          >
            ← back to campaigns
          </Link>
        </div>
      </main>
    );
  }

  // `?? []` once, here, so the six components below can each assume an array.
  // The alternative — a null check inside every child — is far more code.
  const list = candidates ?? [];

  return (
    <main className="theme-console min-h-screen bg-background">
      <WorkspaceTheme />
      <Toaster position="top-right" />
      <header className="sticky top-0 z-30 border-b border-panel-border bg-background">
        <div className="mx-auto flex h-16 max-w-[1400px] flex-wrap items-center gap-3 px-6">
          <Link to="/campaigns" className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
            campaigns
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground">
            #{campaign.id}
          </span>
          <StatusPill status={campaign.status} />
          <div className="ml-auto flex items-center gap-2">
            <Chip tone={live ? "success" : "muted"}>
              {live ? "streaming" : "idle"} · iter {campaign.iteration}
            </Chip>
          </div>
        </div>
      </header>

      {/* THE DASHBOARD ASSEMBLY. Note how thin this is: each component owns its
          own rendering, so the page only decides what appears and in what
          order. That is the payoff of keeping the campaign components purely
          presentational. */}
      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8">
        <SearchController
          campaign={campaign}
          projectId={campaign.project_id}
          onChanged={() => void qc.invalidateQueries({ queryKey: campaignKeys.detail(campaignId) })}
        />

        <div className="grid gap-6 xl:grid-cols-2">
          <ProgressCurve candidates={list} />
          <ParetoChart points={frontier ?? []} />
        </div>

        <AgentMetricsTile metrics={campaign.metrics} />

        <LeaderboardTable rows={leaderboard ?? []} />

        <div className="grid gap-6 xl:grid-cols-2">
          <LineageGraph candidates={list} />
          <SearchTracePanel events={trace} live={live} />
        </div>

        <FailureTaxonomy candidates={list} />
      </div>
    </main>
  );
}

/**
 * The live event stream panel. Defined here rather than in `campaign/` because
 * it is specific to this page and consumes the socket state above.
 */
function SearchTracePanel({ events, live }: { events: SearchTraceEvent[]; live: boolean }) {
  // AUTO-SCROLL TO BOTTOM — the expected behaviour for a live log.
  //
  // `useRef<HTMLDivElement>` attached via the `ref` prop below gives direct
  // access to the real DOM node, which is necessary because scroll position is
  // not something React state can express.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Runs AFTER the DOM updates, so `scrollHeight` already includes the newly
    // appended event. Doing this during render would scroll to the previous
    // height and always lag one event behind.
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [events.length]);
  // ^ Depending on `.length` rather than on `events` itself is deliberate: the
  //   array identity changes on every socket message, but the length is what
  //   actually indicates a new row to scroll to.

  return (
    <Panel>
      <PanelHead
        kicker="proposer · live trace"
        title="Search stream"
        subtitle="inspect → hypothesize → edit → evaluate, straight off the loop."
        meta={<Chip tone={live ? "success" : "muted"}>{events.length} events</Chip>}
      />
      {events.length === 0 ? (
        <EmptyState
          label={live ? "waiting for the first event…" : "stream idle"}
          hint="Events appear while a campaign is running."
        />
      ) : (
        <div ref={scroller} className="max-h-[420px] overflow-auto px-6 py-4 font-mono text-[12px] leading-[1.7]">
          {events.map((ev, i) => (
            <div key={i} className="flex gap-3">
              <span className="shrink-0 text-muted-foreground/50">
                {ev.iteration != null ? `it${ev.iteration}` : "—"}
              </span>
              <span
                className={
                  ev.phase === "evaluate"
                    ? "shrink-0 text-success"
                    : ev.phase === "edit"
                      ? "shrink-0 text-primary"
                      : "shrink-0 text-muted-foreground"
                }
              >
                {/* `padEnd` pads the phase name to a fixed width so the
                    message column lines up down the log. In a monospace font
                    this produces clean columns without a table. */}
                {(ev.phase ?? ev.type).padEnd(11, " ")}
              </span>
              <span className="text-foreground/80">
                {ev.message ?? ev.status ?? ""}
                {ev.candidate_id != null && (
                  <Link
                    to="/candidates/$id"
                    params={{ id: String(ev.candidate_id) }}
                    className="ml-2 text-primary hover:underline"
                  >
                    c{ev.candidate_id}
                  </Link>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
