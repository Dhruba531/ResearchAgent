// TanStack Start configuration — the server-side setup that wraps every
// request and every server function before your route code runs.
//
// Think of the middleware here as layers around your handlers. A request enters
// from the outside, passes down through each middleware, reaches the route, and
// the response travels back out through the same layers.

import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

/**
 * Catch-all error handler for HTTP requests.
 *
 * `createMiddleware().server(fn)` registers a function that runs ON THE SERVER
 * ONLY. The `next` argument continues the chain — calling it runs the rest of
 * the middleware and, eventually, the actual route handler. Because everything
 * downstream happens inside `await next()`, wrapping that call in try/catch
 * catches any error thrown anywhere deeper in the request.
 */
const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    // Errors carrying a `statusCode` are deliberate HTTP responses — a 404 from
    // a missing record, a 401 from a failed auth check, a redirect. Those are
    // control flow, not bugs, so re-throw and let the framework turn them into
    // the right response.
    //
    // The `error != null && typeof error === "object"` guard before the `in`
    // check is required: JavaScript lets you `throw` literally anything (a
    // string, a number, null), and the `in` operator throws its own TypeError
    // if the right-hand side is not an object. Without the guard, a thrown
    // string here would crash the error handler itself.
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }

    // Anything else is an unexpected crash. Log it server-side for debugging,
    // then return a generic 500 page. Note what is NOT sent to the browser:
    // the error message and stack trace. Leaking those to users exposes file
    // paths, dependency versions, and sometimes secrets from error strings.
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

/**
 * Register the middleware with TanStack Start.
 *
 * The two arrays hook into different things, and the distinction matters:
 *
 * - `requestMiddleware` wraps full HTTP requests — page loads, API routes.
 * - `functionMiddleware` wraps SERVER FUNCTIONS, the RPC-style calls the client
 *   makes into the server (see `src/lib/api.ts`, which is built almost entirely
 *   out of them).
 *
 * `attachSupabaseAuth` sits in the function list so that every server function
 * automatically has the caller's authenticated Supabase session attached before
 * its body runs. That is why the functions in `api.ts` can assume they know who
 * is calling without each one repeating the auth lookup.
 */
export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware],
}));
