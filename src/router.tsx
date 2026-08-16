// Router construction. This file is small but it is the hinge the whole app
// hangs off — every page you see is reached through the router built here.

import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * Build the app's router instance.
 *
 * Note this is a FACTORY (a function that returns a new router) rather than a
 * single exported `router` constant. That matters for server-side rendering:
 * the server handles many users' requests at once, and each one needs its own
 * router and its own QueryClient. A module-level singleton would be shared
 * across requests, which would leak one user's cached data into another user's
 * page. Calling `getRouter()` per request keeps them isolated.
 *
 * The pieces:
 *
 * - `routeTree` comes from `./routeTree.gen` — a GENERATED file. Do not edit
 *   it by hand. The TanStack Router Vite plugin scans `src/routes/` and rebuilds
 *   it whenever you add or rename a route file. This is "file-based routing":
 *   the filename determines the URL. `campaigns.$id.tsx` becomes the route
 *   `/campaigns/$id`, where `$id` is a dynamic segment matching any value.
 *
 * - `context: { queryClient }` injects the React Query client into the router's
 *   context, so every route's `loader` can reach it. That is what allows a route
 *   to prefetch data on the server and hand the already-populated cache to the
 *   browser, instead of the page mounting empty and fetching a second time.
 *
 * - `scrollRestoration: true` makes the router remember scroll position per
 *   route, so hitting Back returns you to where you were rather than the top.
 *
 * - `defaultPreloadStaleTime: 0` means preloaded route data is treated as stale
 *   the instant it arrives, so React Query will refetch it on mount. The router
 *   preloads on link hover; setting 0 keeps that purely a latency optimisation
 *   and never lets a hover result get served as fresh data later.
 */
export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
