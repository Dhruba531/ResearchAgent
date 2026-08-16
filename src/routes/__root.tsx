// THE ROOT ROUTE — the ancestor of every page in the app.
//
// The double underscore in `__root.tsx` is TanStack Router's reserved name for
// this file. It is not a URL of its own; it wraps every other route, so
// anything rendered here appears on every page.
//
// What lives here:
//   • the <html>/<head>/<body> document shell (`RootShell`)
//   • global <head> tags — title, description, social preview, fonts
//   • the React Query provider, so every page can use `useQuery`
//   • the 404 and error screens
//   • the post-OAuth redirect handler (`PostAuthRedirectConsumer`)
//
// Anything needed on EVERY page belongs here. Anything else does not — this
// file is on the critical path for the entire app.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { supabase } from "@/integrations/supabase/client";

// Must match the key written in `components/operator-console.tsx`. The two
// halves of the OAuth redirect flow are in different files, and this string is
// the contract between them — a mismatch would silently lose the destination.
const REDIRECT_STORAGE_KEY = "agentlab.postAuthRedirect";

/**
 * Same open-redirect defence as `sanitizeRedirect` in operator-console.tsx —
 * see that file for the full explanation of the attack this prevents.
 *
 * Two differences: this returns `null` rather than a default path (the caller
 * simply does nothing when there is no valid destination), and it re-validates
 * a value read back from storage.
 *
 * Re-validating is not redundant. The value was sanitised before being stored,
 * but sessionStorage is writable by any script on the origin, so anything read
 * back out is untrusted input again. Validate at the point of USE, not only at
 * the point of storage.
 */
function sanitizeStoredRedirect(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const path = url.pathname + url.search + url.hash;
    if (!path.startsWith("/") || path.startsWith("//")) return null;
    if (path.startsWith("/auth")) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * Completes the OAuth sign-in flow started in `operator-console.tsx`.
 *
 * The problem it solves: signing in with Google navigates away to Google and
 * then back, destroying all React state in between. The intended destination
 * was therefore stashed in sessionStorage before leaving; this component picks
 * it up on return and performs the navigation.
 *
 * It renders `null` — a behaviour-only component, mounted in `RootComponent`
 * so it is listening on every page, since OAuth can return to any of them.
 */
function PostAuthRedirectConsumer() {
  const router = useRouter();
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Subscribe to Supabase auth events rather than checking once on mount.
    // The session is restored asynchronously after the page loads, so a
    // one-shot check on mount would usually run too early and see nobody
    // signed in.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN") return;
      let stored: string | null = null;
      try {
        stored = window.sessionStorage.getItem(REDIRECT_STORAGE_KEY);
      } catch {
        stored = null;
      }
      const dest = sanitizeStoredRedirect(stored);
      if (!dest) return;
      try {
        window.sessionStorage.removeItem(REDIRECT_STORAGE_KEY);
      } catch {
        // ignore
      }
      // Only take over navigation when the user isn't already on the target.
      // Navigating to the current location would be a pointless re-render, and
      // could fight with a navigation the user just made themselves.
      if (window.location.pathname + window.location.search + window.location.hash === dest) {
        return;
      }
      // `replace: true` overwrites the current history entry instead of adding
      // one, so pressing Back does not send the user through the sign-in
      // redirect again — it takes them to wherever they were before.
      router.navigate({ to: dest, replace: true });
    });
    return () => {
      // Unsubscribe on unmount. An auth listener left attached would keep this
      // component's closure alive and fire on every future auth event.
      sub.subscription.unsubscribe();
    };
  }, [router]);
  // Renders nothing — same pattern as `WorkspaceTheme` in
  // components/workspace-theme.tsx.
  return null;
}

/** Shown for any URL that matches no route. Wired up as `notFoundComponent`. */
function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-serif text-foreground">404</h1>
        <p className="mt-4 text-muted-foreground">This page doesn't exist.</p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

/**
 * The app-level ERROR BOUNDARY. Rendered when a route throws during render,
 * instead of the white screen an uncaught React error would otherwise produce.
 *
 * Distinct from `lib/error-page.ts`: that one is server-rendered HTML for when
 * the app cannot boot at all, whereas this runs inside a working React app that
 * hit a problem on one route.
 */
function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">Something went wrong.</p>
        {/* Both calls are needed, and the order matters. `router.invalidate()`
            discards cached route data — retrying without it would re-render the
            same bad data and fail identically. `reset()` then clears the error
            boundary so the route is allowed to render again. */}
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

// `createRootRouteWithContext<T>()` declares the type of the context every
// route can access. The QueryClient is injected in `src/router.tsx`; naming its
// type here is what makes `Route.useRouteContext()` type-safe further down, and
// what lets any route's loader reach the query cache.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // `head` supplies the document's <head> tags. Defined here so they apply to
  // every page; individual routes can add or override their own.
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AgentLab — Ship agents you can defend" },
      {
        name: "description",
        content:
          "Governed AI coding-agents with human gates, live logs, signed artifacts, reviewer panels, and final export control.",
      },
      // OPEN GRAPH tags. These control the preview card shown when a link is
      // pasted into Slack, iMessage, LinkedIn, and so on — the title, blurb,
      // and image below are what those unfurlers read. Twitter has its own
      // near-duplicate set for historical reasons, which is why the same
      // content appears twice.
      { property: "og:title", content: "AgentLab — Ship agents you can defend" },
      {
        property: "og:description",
        content:
          "Governed AI coding-agents with human gates, live logs, signed artifacts, reviewer panels, and final export control.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "AgentLab — Ship agents you can defend" },
      {
        name: "twitter:description",
        content:
          "Governed AI coding-agents with human gates, live logs, signed artifacts, reviewer panels, and final export control.",
      },
    ],
    links: [
      // The app's compiled stylesheet. Imported at the top with Vite's `?url`
      // suffix, which yields the final hashed asset path rather than inlining
      // the CSS.
      { rel: "stylesheet", href: appCss },
      // `preconnect` opens the DNS, TCP, and TLS connection to the font host
      // EARLY, in parallel with parsing, so the font request does not pay that
      // setup cost when it is finally made. Two hosts because Google serves the
      // CSS and the font files from different domains.
      //
      // `crossOrigin="anonymous"` is required on the gstatic entry — font files
      // are fetched in CORS mode, and a preconnect without it opens a
      // connection that the actual request cannot reuse, wasting the hint.
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      // The three typefaces this app uses: Archivo for headings, IBM Plex Sans
      // for body text, IBM Plex Mono for the numbers and labels throughout the
      // console.
      //
      // `display=swap` renders text in a fallback font immediately and swaps in
      // the web font once it arrives. Without it the browser hides the text for
      // up to three seconds while fonts load — the "flash of invisible text".
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  // The four component slots this route fills:
  shellComponent: RootShell,          // the <html> document itself
  component: RootComponent,           // wraps every page's content
  notFoundComponent: NotFoundComponent, // no route matched
  errorComponent: ErrorComponent,       // a route threw
});

/**
 * The document shell. Note this component renders the <html> and <body> tags
 * themselves — which is why the project has no `index.html` file. React owns
 * the entire document, and TanStack Start renders it to HTML on the server.
 */
function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Renders everything from the `head` config above. */}
        <HeadContent />
      </head>
      <body>
        {children}
        {/* Injects the client bundle's <script> tags. Placed at the END of
            <body> so parsing and painting are not blocked. Removing this would
            produce a page that server-renders correctly and is then completely
            inert — no hydration, no interactivity. */}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Wraps every page. Deliberately tiny — anything added here runs on every
 * single route, so it is the wrong place for anything a page can own itself.
 */
function RootComponent() {
  // Reads the context declared by `createRootRouteWithContext` and supplied in
  // `src/router.tsx`. Per-request on the server, so one user's cached data
  // cannot leak into another's page.
  const { queryClient } = Route.useRouteContext();
  return (
    // Makes the query cache available to `useQuery` anywhere below. Without
    // this provider every hook in `lib/campaign-queries.ts` would throw.
    <QueryClientProvider client={queryClient}>
      {/* Renders nothing; listens for the OAuth return. */}
      <PostAuthRedirectConsumer />
      {/* <Outlet> is where the MATCHED ROUTE renders. This is the hole in the
          layout that each page fills — the single most important concept in
          nested routing. */}
      <Outlet />
    </QueryClientProvider>
  );
}
