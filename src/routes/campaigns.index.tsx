// The campaign LIST page (/campaigns), as distinct from the campaign DETAIL
// page in `campaigns.$id.tsx`.
//
// The `.index` in the filename is TanStack Router's convention for the route
// that matches a directory's own path. So `campaigns.index.tsx` serves
// /campaigns exactly, while `campaigns.$id.tsx` serves /campaigns/<anything>.
//
// Interesting contrast to study here: this page fetches projects with a RAW
// `useEffect` + `useState`, while fetching campaigns through TanStack Query.
// Both patterns sit side by side, which makes the difference easy to see —
// see the comment on the effect below.

import { createFileRoute, isRedirect, Link, redirect } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Toaster, toast } from "sonner";
import { WorkspaceTheme } from "@/components/workspace-theme";
import { listProjects, me, type CampaignOut, type ProjectOut } from "@/lib/api";
import { useCampaigns } from "@/lib/campaign-queries";
import { Chip, EmptyState, Panel, PanelHead, StatusPill, fmtNum, fmtUsd } from "@/components/campaign/primitives";
import { SearchController } from "@/components/campaign/search-controller";

export const Route = createFileRoute("/campaigns/")({
  ssr: false,
  // The same auth guard as `campaigns.$id.tsx` — see that file for a full
  // explanation of why the redirect is thrown rather than returned, and why
  // `isRedirect` must be re-thrown from the catch.
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
      { title: "Search campaigns — AgentLab" },
      {
        name: "description",
        content:
          "Launch and monitor autoresearch search campaigns: compute budgets, exploration rate, edit-family weights, and the candidate archive.",
      },
      { property: "og:title", content: "Search campaigns — AgentLab" },
      {
        property: "og:description",
        content: "Launch and monitor autoresearch search campaigns across your research projects.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CampaignsPage,
});

function CampaignsPage() {
  // MANUAL DATA FETCHING — three pieces of state doing by hand what TanStack
  // Query does for you. This is exactly the boilerplate described at the top of
  // `lib/campaign-queries.ts`: a value, a loading flag, and error handling,
  // all wired up individually.
  const [projects, setProjects] = useState<ProjectOut[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listProjects()
      .then((list) => {
        setProjects(list);
        // Auto-select the first project so the page is useful on arrival
        // rather than showing an empty selector.
        if (list.length) setProjectId(list[0].id);
      })
      .catch(() => toast.error("Could not load projects — is the runner reachable?"))
      // `.finally` clears the flag on both paths — the promise equivalent of
      // the `try/finally` used in governance.tsx.
      .finally(() => setLoading(false));
  }, []); // Empty deps: fetch once on mount.

  // Compare the line below with the fifteen above. `useCampaigns` gives data,
  // loading state, error handling, caching, and polling in one call. The
  // projects fetch gets none of that — no cache, no refetch, and a re-mount
  // re-requests from scratch. Worth converting if you touch this file.
  const { data: campaigns, isLoading, refetch } = useCampaigns(projectId);
  // `?? []` memoised so `rows` keeps a stable identity between renders — a new
  // `[]` each time would defeat memoisation in any child that depends on it.
  const rows = useMemo(() => campaigns ?? [], [campaigns]);

  return (
    <main className="theme-console min-h-screen bg-background">
      <WorkspaceTheme />
      <Toaster position="top-right" />
      <header className="sticky top-0 z-30 border-b border-panel-border bg-background">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-6">
          <Link to="/console" search={{ tl: undefined }} className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
            console
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground">campaigns</span>
          <div className="ml-auto flex items-center gap-3">
            {/* `?? ""` because a controlled <select> needs a defined value —
                passing null would make React treat it as uncontrolled and warn.
                The empty string pairs with the "no projects" option below. */}
            <select
              value={projectId ?? ""}
              onChange={(e) => setProjectId(Number(e.target.value))}
              className="rounded border border-panel-border bg-background px-3 py-1.5 font-mono text-[12px] text-foreground"
              aria-label="Project"
            >
              {projects.length === 0 && <option value="">no projects</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-8">
        <div>
          <div className="mono-label">autoresearch · search harness</div>
          <h1 className="mt-2 font-serif text-3xl tracking-tight text-foreground">Search campaigns</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
            A campaign runs the propose → edit → evaluate loop under hard compute caps, writing every
            candidate to the archive so improvements can be audited, not just admired.
          </p>
        </div>

        {/* The SAME SearchController as the detail page, but with
            `campaign={null}` — meaning "no campaign running", so it renders as
            a launch form rather than a live control panel. One component
            serving both roles, driven entirely by its props.

            `onChanged` refetches the list so a newly started campaign appears
            immediately. */}
        <SearchController campaign={null} projectId={projectId} onChanged={() => void refetch()} />

        <Panel>
          <PanelHead
            kicker="ledger"
            title="Campaigns"
            subtitle="Every search run for this project, newest first."
            meta={<Chip tone="info">{rows.length}</Chip>}
          />
          {/* Both loading flags checked together: `loading` for the manual
              projects fetch, `isLoading` from TanStack Query for the campaigns.
              Either one pending means the list is not ready. */}
          {loading || isLoading ? (
            <div className="flex items-center justify-center gap-2 px-6 py-10 font-mono text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              label="no campaigns yet"
              hint="Set a budget above and start the loop to populate the archive."
            />
          ) : (
            <ul className="divide-y divide-panel-border">
              {rows.map((c) => (
                <CampaignRow key={c.id} campaign={c} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </main>
  );
}

/**
 * One row in the campaign list.
 *
 * Note the <Link> wraps the ENTIRE row rather than just the id text, so the
 * whole strip is a click target. Much easier to hit than a small text link, and
 * it still renders as a real anchor — so middle-click and "open in new tab"
 * behave as expected.
 */
function CampaignRow({ campaign }: { campaign: CampaignOut }) {
  return (
    <li>
      <Link
        to="/campaigns/$id"
        params={{ id: String(campaign.id) }}
        className="flex flex-wrap items-center gap-4 px-6 py-4 transition-colors hover:bg-primary/5"
      >
        <span className="font-mono text-[13px] text-foreground">
          #{campaign.id} {campaign.name ? `· ${campaign.name}` : ""}
        </span>
        <StatusPill status={campaign.status} />
        <span className="font-mono text-[11.5px] text-muted-foreground">
          iter {campaign.iteration}
          {campaign.config?.budget?.max_iters ? ` / ${campaign.config.budget.max_iters}` : ""}
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          best {fmtNum(campaign.best_score)}
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          spend {fmtUsd(campaign.spend?.usd ?? 0)}
        </span>
        <ArrowUpRight className="ml-auto h-4 w-4 text-muted-foreground" />
      </Link>
    </li>
  );
}
