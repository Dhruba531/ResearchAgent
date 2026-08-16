// TanStack Query hooks for the search-harness surfaces (campaigns, candidates,
// leaderboard, Pareto frontier, traces). Polling intervals tighten while a
// campaign is running and relax once it stops.
//
// ===========================================================================
// WHAT TANSTACK QUERY DOES, AND WHY THIS FILE EXISTS
// ===========================================================================
// Without it, fetching data in React means writing this in every component:
//
//   const [data, setData] = useState(null);
//   const [loading, setLoading] = useState(true);
//   const [error, setError] = useState(null);
//   useEffect(() => { fetch(...).then(setData).catch(setError)... }, [id]);
//
// …plus refetching, caching, deduplication, and stale-data handling, all by
// hand, in every component. TanStack Query replaces all of it with:
//
//   const { data, isLoading, error } = useCampaign(id);
//
// The important properties it adds beyond brevity:
//
//   • CACHING — two components calling `useCampaign(5)` share ONE request and
//     one cached result. This is why the hooks below can be called freely
//     wherever the data is needed, with no prop-drilling.
//   • BACKGROUND REFETCHING — cached data renders immediately while a fresh
//     copy is fetched behind it, so navigation feels instant.
//   • POLLING — `refetchInterval` re-fetches on a timer, which is what keeps
//     a live campaign's numbers moving without any WebSocket.
//
// This file is the layer between `src/lib/api.ts` (raw fetch calls) and the
// components: `api.ts` knows HOW to fetch, this file knows WHEN.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCampaign,
  getCandidate,
  getCandidateTrace,
  getFrontier,
  getLeaderboard,
  listCampaigns,
  listCandidates,
  type CampaignOut,
} from "@/lib/api";

// Two polling speeds, in milliseconds (the `_` separators are ignored by
// JavaScript and only aid readability): 4 seconds while something is actively
// running, 30 seconds when idle.
//
// The distinction is a real cost trade-off, not fussiness. Every poll is an
// HTTP request per viewer; polling a finished campaign every 4s would generate
// continuous load to re-fetch data that cannot change.
const LIVE = 4_000;
const IDLE = 30_000;

/**
 * Is this campaign still doing work?
 *
 * "queued" counts as live because a queued campaign is about to start, and we
 * want to notice that transition promptly rather than up to 30 seconds late.
 *
 * The `?.` handles undefined/null in one expression, so callers can pass data
 * that has not loaded yet without a separate guard.
 */
export function isLive(c: CampaignOut | undefined | null): boolean {
  return c?.status === "running" || c?.status === "queued";
}

/**
 * Centralised QUERY KEYS.
 *
 * A query key is the cache identity of a piece of data — TanStack Query uses it
 * to decide what to reuse, what to dedupe, and what to invalidate. Keys are
 * arrays, and they are hierarchical: `["campaign", 5]` is a PREFIX of
 * `["campaign", 5, "leaderboard"]`, which is what lets `useCampaignInvalidator`
 * at the bottom of this file clear every cache for one campaign in a single
 * call.
 *
 * Defining them in one object rather than inline at each `useQuery` is the
 * point. A typo in an inline key does not error — it silently creates a second
 * cache entry, so you get stale data with no clue why. Here the keys are
 * written once and used everywhere.
 *
 * `as const` makes each returned array a readonly tuple of literal types, which
 * gives TanStack Query precise types instead of a widened `string[]`.
 */
export const campaignKeys = {
  list: (projectId: number) => ["campaigns", projectId] as const,
  detail: (id: number) => ["campaign", id] as const,
  // Sort and filter are part of the key because differently-sorted results are
  // DIFFERENT DATA and must not share a cache entry. The `?? ""` normalises
  // undefined so that "no sort specified" always produces the same key rather
  // than one key with `undefined` and another with a value.
  candidates: (id: number, sort?: string, filter?: string) =>
    ["campaign", id, "candidates", sort ?? "", filter ?? ""] as const,
  leaderboard: (id: number) => ["campaign", id, "leaderboard"] as const,
  frontier: (id: number) => ["campaign", id, "frontier"] as const,
  candidate: (id: number) => ["candidate", id] as const,
  trace: (id: number) => ["candidate", id, "trace"] as const,
};

/**
 * All campaigns for a project.
 *
 * Demonstrates the `enabled` option — the standard solution to "I need to fetch
 * as soon as I have an ID, but I might not have one yet." Hooks cannot be
 * called conditionally (React's rules of hooks), so instead the hook always
 * runs and `enabled: false` tells it to sit idle.
 */
export function useCampaigns(projectId: number | null) {
  return useQuery({
    // `?? -1` only supplies a placeholder so the key function has a number to
    // work with. It is never fetched, because `enabled` is false in exactly the
    // case where the -1 appears.
    queryKey: campaignKeys.list(projectId ?? -1),
    // `as number` asserts non-null, which is safe here for the same reason.
    queryFn: () => listCampaigns(projectId as number),
    enabled: projectId != null,
    // `retry: false` on every hook in this file. TanStack Query retries three
    // times by default, which is right for flaky networks but wrong here: if
    // the backend is unconfigured or the user lacks access, retrying just
    // delays the error the UI needs to show. Failing fast keeps the interface
    // honest. Note `!=` (loose) is deliberate — it catches both null and
    // undefined, unlike `!==`.
    retry: false,
  });
}

/**
 * One campaign's detail. The only hook that decides its own polling speed.
 */
export function useCampaign(campaignId: number) {
  return useQuery({
    queryKey: campaignKeys.detail(campaignId),
    queryFn: () => getCampaign(campaignId),
    // `refetchInterval` accepts a FUNCTION, evaluated after each fetch, so the
    // interval can adapt to the data just received. This is the self-regulating
    // bit: while the campaign is running it polls every 4s; the moment it
    // reports "completed", the next interval relaxes to 30s automatically. No
    // component has to remember to stop polling.
    refetchInterval: (q) => (isLive(q.state.data) ? LIVE : IDLE),
    retry: false,
  });
}

/**
 * Candidates within a campaign, optionally sorted and filtered.
 *
 * Unlike `useCampaign` above, these hooks take `live` as a PARAMETER rather
 * than deriving it — the caller already knows whether the parent campaign is
 * running (usually from `useCampaign`), so passing it down avoids every hook
 * independently re-deriving the same fact.
 */
export function useCandidates(
  campaignId: number,
  opts: { sort?: string; filter?: string; live?: boolean } = {},
) {
  return useQuery({
    // sort/filter flow into the key — see the note on `campaignKeys.candidates`.
    queryKey: campaignKeys.candidates(campaignId, opts.sort, opts.filter),
    queryFn: () => listCandidates(campaignId, { sort: opts.sort, filter: opts.filter }),
    refetchInterval: opts.live ? LIVE : IDLE,
    retry: false,
  });
}

/** Ranked candidate table. Rendered by `campaign/leaderboard-table.tsx`. */
export function useLeaderboard(campaignId: number, live = false) {
  return useQuery({
    queryKey: campaignKeys.leaderboard(campaignId),
    queryFn: () => getLeaderboard(campaignId),
    refetchInterval: live ? LIVE : IDLE,
    retry: false,
  });
}

/** Pareto frontier — the cost/quality trade-off. Rendered by `pareto-chart.tsx`. */
export function useFrontier(campaignId: number, live = false) {
  return useQuery({
    queryKey: campaignKeys.frontier(campaignId),
    queryFn: () => getFrontier(campaignId),
    refetchInterval: live ? LIVE : IDLE,
    retry: false,
  });
}

/**
 * A single candidate's detail.
 *
 * No `refetchInterval` at all — once a candidate has been evaluated its result
 * is final, so polling it would re-fetch identical bytes forever. Recognising
 * which data is immutable is what keeps the request volume sane.
 */
export function useCandidate(candidateId: number) {
  return useQuery({
    queryKey: campaignKeys.candidate(candidateId),
    queryFn: () => getCandidate(candidateId),
    retry: false,
  });
}

/**
 * A candidate's execution trace — what the agent actually did, step by step.
 *
 * `enabled` is exposed as a parameter here because traces are large and only
 * needed when the user opens the trace panel. Callers pass `enabled={isOpen}`
 * so the payload is fetched on demand rather than for every candidate rendered.
 */
export function useCandidateTrace(candidateId: number, enabled = true) {
  return useQuery({
    queryKey: campaignKeys.trace(candidateId),
    queryFn: () => getCandidateTrace(candidateId),
    enabled,
    retry: false,
  });
}

/** Invalidate every campaign-scoped cache — used by WS events and controls. */
//
// INVALIDATION is how you say "this cached data is now wrong; refetch it".
// Needed when something changes the data outside of polling: a WebSocket event
// arrives (see `openSearchTrace` in api.ts), or the user clicks Stop.
//
// This returns a FUNCTION rather than doing the work, so components can hold
// onto it and call it later from an event handler — the standard shape for an
// imperative action derived from hooks.
export function useCampaignInvalidator(campaignId: number) {
  // `useQueryClient` reaches the shared cache created in `src/router.tsx`.
  const qc = useQueryClient();
  return () => {
    // Two calls, and the second is the interesting one. Query keys match by
    // PREFIX, so `["campaign", 5]` invalidates `["campaign", 5, "leaderboard"]`,
    // `["campaign", 5, "frontier"]`, and every other key beginning that way —
    // the whole subtree in one call. That is exactly the hierarchy the
    // `campaignKeys` object was designed around.
    //
    // The first call is therefore redundant, being a strict prefix of the
    // second. Harmless, and explicit about intent.
    //
    // `void` discards the returned promise deliberately: invalidation is
    // fire-and-forget, and the `void` operator marks that as intentional so
    // linters do not flag an unhandled promise.
    void qc.invalidateQueries({ queryKey: campaignKeys.detail(campaignId) });
    void qc.invalidateQueries({ queryKey: ["campaign", campaignId] });
  };
}
