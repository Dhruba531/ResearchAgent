// The /auth page — the layout wrapper around <OperatorConsole>.
//
// A clean example of the SEPARATION this codebase keeps between routes and
// components: the route owns the URL, the page metadata, and the layout, while
// the form logic lives entirely in `components/operator-console.tsx`. Read this
// for the routing concepts, and that file for the form handling.
//
// The `validateSearch` block below is the part worth studying — it is how
// TanStack Router makes query-string parameters type-safe.

import { createFileRoute, Link } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { OperatorConsole } from "@/components/operator-console";

// The query parameters this route accepts: /auth?redirect=/console
type AuthSearch = { redirect?: string };

// `createFileRoute("/auth")` ties this file to the URL. The path string must
// match the filename — the router plugin generates it, so do not edit it by
// hand.
export const Route = createFileRoute("/auth")({
  component: AuthPage,
  // VALIDATE SEARCH PARAMS. Query strings are arbitrary user input: anyone can
  // type `?redirect[]=1&foo=bar` into the address bar. This function is the
  // boundary where that untyped input becomes a typed object.
  //
  // Two things come out of it. At runtime, anything that is not a string is
  // discarded. At compile time, the RETURN TYPE is what gives `Route.useSearch()`
  // its type — which is why `search.redirect` is known to be `string | undefined`
  // in operator-console.tsx rather than `any`.
  //
  // Note this validates the SHAPE only. Whether the redirect is safe to follow
  // is a separate question, answered by `sanitizeRedirect` at the point of use.
  // Type-safe is not the same as trustworthy.
  validateSearch: (search: Record<string, unknown>): AuthSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  // Page-specific <head> tags, MERGED with the defaults in `__root.tsx`. The
  // title here overrides the root's; anything not restated is inherited.
  head: () => ({
    meta: [
      { title: "Sign in · AgentLab" },
      { name: "description", content: "Sign in or register for the AgentLab operator console." },
    ],
  }),
});

function StatusDot() {
  return <span className="block h-2 w-2 rounded-full bg-primary" />;
}

function AuthPage() {
  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      {/* subtle grid background */}
      {/* A graph-paper texture built from two CSS gradients rather than an
          image — one drawing vertical lines, one horizontal, tiled every 44px.
          No network request, and it scales to any viewport.

          `pointer-events-none` is essential: without it this full-screen
          overlay would sit above the form and swallow every click. Any
          decorative absolute overlay needs it. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />



      <header className="relative z-10 border-b border-border/40">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-5">
          <Link to="/" className="flex items-baseline gap-2">
            <span className="font-mono text-[13px] leading-none text-primary">[/]</span>
            <span className="font-serif text-xl leading-none text-foreground">AgentLab</span>
          </Link>

          <Link
            to="/"
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            ← Back to home
          </Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-[1200px] flex-1 items-center px-6 py-10 md:py-14">
        {/* A two-column grid on large screens. `[1.05fr_minmax(0,420px)]` is
            arbitrary-value syntax for a custom `grid-template-columns`: the
            left column takes the remaining space, the right is capped at 420px.
            `minmax(0, …)` rather than a bare width is the grid equivalent of
            `min-w-0` — it lets the column shrink below its content instead of
            overflowing. */}
        <div className="grid w-full items-center gap-10 lg:grid-cols-[1.05fr_minmax(0,420px)] lg:gap-12">
          {/* Brand / context panel — desktop only. `hidden lg:block` removes it
              entirely below 1024px, where there is no room. The heading it
              contains is repeated in a compact form in the form column below,
              guarded by the inverse `lg:hidden`, so exactly one is ever
              visible. */}
          <div className="hidden min-w-0 lg:block">
            <span className="inline-flex items-center gap-2 rounded-full border border-panel-border bg-panel px-3 py-1 font-mono text-[11px] tracking-wider text-muted-foreground">
              <StatusDot /> operator access
            </span>
            <h1
              className="mt-6 font-serif font-normal leading-[1.05] tracking-[-0.02em] text-foreground"
              // FLUID TYPOGRAPHY: `clamp(min, preferred, max)` scales the font
              // with the viewport (3.8vw) but never below 2.1rem or above
              // 3.1rem. One declaration replaces a set of breakpoint overrides.
              style={{ fontSize: "clamp(2.1rem, 3.8vw, 3.1rem)" }}
            >
              Sign in to the console.
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted-foreground">
              Accounts are per-workspace. Your role decides what you can do
              once you're in — operators start runs, reviewers approve them,
              viewers can only read.
            </p>

            {/* <dl>/<dt>/<dd> — a DESCRIPTION LIST, the semantically correct
                element for key/value pairs. A stack of <div>s would look
                identical and mean nothing to a screen reader. */}
            <dl className="mt-8 max-w-md divide-y divide-panel-border border-t border-panel-border font-mono text-[11px]">
              {[
                ["session", "HttpOnly cookie, signed server-side"],
                ["backend", "FastAPI runner at your API base URL"],
                ["oauth", "Google, optional"],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-5 py-2.5">
                  <dt className="w-20 shrink-0 uppercase tracking-wider text-muted-foreground">
                    {k}
                  </dt>
                  <dd className="text-foreground/85">{v}</dd>
                </div>
              ))}
            </dl>
          </div>


          {/* Form column */}
          <div className="mx-auto min-w-0 w-full max-w-[440px] lg:mx-0">
            <div className="mb-6 lg:hidden">
              <span className="inline-flex items-center gap-2 rounded-full border border-panel-border bg-panel px-3 py-1 font-mono text-[11px] tracking-wider text-muted-foreground">
                <StatusDot /> operator access
              </span>
              <h1 className="mt-4 font-serif text-3xl font-normal leading-tight tracking-tight text-foreground">
                Sign in to the console.
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Your role decides what you can do once you're in.
              </p>
            </div>
            <OperatorConsole />
          </div>
        </div>
      </main>

      <footer className="relative z-10 border-t border-border/40 py-5 text-center font-mono text-[11px] tracking-wider text-muted-foreground/60">
        agentlab · build 2026.04
      </footer>


      {/* The toast HOST. `toast.success(...)` calls anywhere in the tree render
          here, so this element must be mounted for any of them to appear —
          a missing <Toaster> is the usual reason toasts silently do nothing. */}
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{ style: { fontFamily: "var(--font-mono)" } }}
      />
    </div>
  );
}
