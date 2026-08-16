// The candidate detail page. Composes two components: `CandidateDetail` (the
// tabbed viewer) and `GovernancePanel` (the promote/reject gate).
//
// The interesting code here is `onUpdated` near the bottom — it shows the
// difference between WRITING to the cache and INVALIDATING it, and why this
// page does both.
//
import { createFileRoute, isRedirect, Link, redirect } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "sonner";
import { WorkspaceTheme } from "@/components/workspace-theme";
import { me, type CandidateOut } from "@/lib/api";
import { campaignKeys, useCandidate, useCandidateTrace } from "@/lib/campaign-queries";
import { CandidateDetail } from "@/components/campaign/candidate-detail";
import { GovernancePanel } from "@/components/campaign/governance";
import { StatusPill } from "@/components/campaign/primitives";

export const Route = createFileRoute("/candidates/$id")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    try {
      const user = await me();
      if (!user) throw redirect({ to: "/auth", search: { redirect: location.href } });
    } catch (err) {
      if (isRedirect(err)) throw err;
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
  },
  head: () => ({
    meta: [
      { title: "Candidate detail — AgentLab" },
      {
        name: "description",
        content:
          "Candidate archive entry: code diff, metrics, stdout/stderr, per-step traces, reviewer notes, and the promotion gate.",
      },
      { property: "og:title", content: "Candidate detail — AgentLab" },
      {
        property: "og:description",
        content: "Inspect a search candidate: diff, metrics, traces, notes, and audit status.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  errorComponent: ({ error }) => (
    <main className="theme-console grid min-h-screen place-items-center px-6" role="alert">
      <div className="panel max-w-md p-6 text-center">
        <p className="mono-label">candidate unavailable</p>
        <p className="mt-2 text-[13px] text-muted-foreground">{error.message}</p>
      </div>
    </main>
  ),
  notFoundComponent: () => (
    <main className="theme-console grid min-h-screen place-items-center px-6">
      <p className="font-mono text-[12px] text-muted-foreground">candidate not found</p>
    </main>
  ),
  component: CandidatePage,
});

function CandidatePage() {
  const { id } = Route.useParams();
  const candidateId = Number(id);
  const qc = useQueryClient();

  const { data: candidate, isLoading, error } = useCandidate(candidateId);
  // DEPENDENT QUERY: the trace only fetches once the candidate has loaded,
  // because `enabled` receives `Boolean(candidate)`. Traces are large payloads,
  // so there is no point requesting one for a candidate that turns out not to
  // exist. See `useCandidateTrace` in lib/campaign-queries.ts.
  //
  // `isLoading: traceLoading` renames the destructured field, which is how you
  // pull the same property from two hooks without a name collision.
  const { data: trace, isLoading: traceLoading } = useCandidateTrace(candidateId, Boolean(candidate));

  if (isLoading) {
    return (
      <main className="theme-console grid min-h-screen place-items-center">
        <span className="inline-flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading candidate
        </span>
      </main>
    );
  }

  if (error || !candidate) {
    return (
      <main className="theme-console grid min-h-screen place-items-center px-6">
        <div className="panel max-w-md p-6 text-center">
          <p className="mono-label">candidate unavailable</p>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {error instanceof Error ? error.message : "The archive did not return this candidate."}
          </p>
          <Link to="/campaigns" className="mt-4 inline-block font-mono text-[12px] text-primary hover:underline">
            ← back to campaigns
          </Link>
        </div>
      </main>
    );
  }

  /**
   * Called by `GovernancePanel` after a successful promote or reject.
   *
   * Two different cache operations, and the distinction is the lesson here:
   *
   *   setQueryData    — writes a known value straight into the cache. No
   *                     network request. Used because the mutation already
   *                     RETURNED the updated candidate, so refetching it would
   *                     be a wasted round trip for data we are holding.
   *
   *   invalidateQueries — marks data as stale and triggers a refetch. Used for
   *                     the parent campaign, because promoting a candidate
   *                     changes the leaderboard, the Pareto frontier, and the
   *                     campaign's aggregate metrics — none of which the
   *                     mutation returned, so they must be re-fetched.
   *
   * The rule: write what you already know, invalidate what you cannot compute.
   */
  const onUpdated = (c: CandidateOut) => {
    qc.setQueryData(campaignKeys.candidate(candidateId), c);
    void qc.invalidateQueries({ queryKey: ["campaign", c.campaign_id] });
  };

  return (
    <main className="theme-console min-h-screen bg-background">
      <WorkspaceTheme />
      <Toaster position="top-right" />
      <header className="sticky top-0 z-30 border-b border-panel-border bg-background">
        {/* BREADCRUMBS: campaigns / #<campaign> / c<candidate>. The middle link
            is built from `candidate.campaign_id`, so the trail reflects this
            candidate's actual parent rather than wherever the user came from. */}
        <div className="mx-auto flex h-16 max-w-[1400px] flex-wrap items-center gap-3 px-6">
          <Link to="/campaigns" className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
            campaigns
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <Link
            to="/campaigns/$id"
            params={{ id: String(candidate.campaign_id) }}
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
          >
            #{candidate.campaign_id}
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground">
            c{candidate.id}
          </span>
          <StatusPill status={candidate.status} />
        </div>
      </header>

      {/* A 2:1 split on extra-large screens, stacking below that. The detail
          viewer gets twice the width; the governance panel is capped to a
          readable sidebar. Both use `minmax(0, …)` so a wide diff or long log
          line cannot force the grid to overflow — the same shrink-to-fit
          guarantee as `min-w-0` in flexbox. */}
      <div className="mx-auto grid max-w-[1400px] gap-6 px-6 py-8 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <CandidateDetail candidate={candidate} trace={trace} traceLoading={traceLoading} />
        <div className="space-y-6">
          <GovernancePanel candidate={candidate} onUpdated={onUpdated} />
        </div>
      </div>
    </main>
  );
}
