// The server entry point — the outermost layer of the whole application.
// Every single HTTP request hits the `fetch` function at the bottom of this
// file before anything else in the codebase runs.
//
// This file exists almost entirely to make errors visible. Read the comments on
// `normalizeCatastrophicSsrResponse` for the interesting part.

// This import has no bindings on purpose — it is imported for its SIDE EFFECT.
// Loading the module installs global error listeners (see error-capture.ts).
// It must be the very first import so the listeners are in place before any
// other module has a chance to throw during its own initialisation.
import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleApiRequest } from "./server-api";

/**
 * The shape we expect TanStack Start's server entry to have. This mirrors the
 * Web Fetch API's handler convention (`{ fetch(request, env, ctx) }`) used by
 * Cloudflare Workers, Deno, and modern Node servers.
 */
type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

// Cache for the lazily-loaded server entry. Note this caches the PROMISE, not
// the resolved value — that is deliberate. If two requests arrive at the same
// time before the import finishes, both see the same in-flight promise and
// await it. Caching only the resolved value would let both start their own
// `import()`, doing the work twice.
let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    // A dynamic `import()` — loaded at runtime on first use rather than at
    // startup. This keeps the cold-start fast, since the heavy SSR machinery is
    // only pulled in when a request actually needs to render a page.
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      // Interop shim: depending on how the module was bundled the handler may
      // be the default export or the module namespace itself. `??` falls back
      // to the whole module when there is no default.
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

/**
 * Recover the real error from an SSR crash that h3 has already swallowed.
 *
 * The problem this solves: h3 (the underlying HTTP layer) catches exceptions
 * thrown inside a handler and converts them into an ordinary 500 Response with
 * the JSON body {"unhandled":true,"message":"HTTPError"}. From our side that is
 * a perfectly normal Response object, not a thrown error — so the try/catch in
 * `fetch` below never fires, and the actual stack trace is lost. You would see
 * a useless generic message with no clue what broke.
 *
 * So instead of catching, we INSPECT the response and detect that fingerprint.
 */
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  // Three cheap guards first, ordered cheapest-to-most-expensive, so the common
  // case (a normal successful response) exits immediately without reading any
  // body. Only 5xx JSON responses are candidates.
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  // `.clone()` is essential. A Response body is a ONE-SHOT stream: reading it
  // consumes it, and any later attempt to read throws. Cloning gives us a
  // separate readable copy so the original stays intact for the early-return
  // paths below, where we hand `response` back to the caller untouched.
  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  // Confirmed: h3 ate a real error. `consumeLastCapturedError()` retrieves
  // whatever the global listeners in error-capture.ts recorded, which is the
  // genuine error with its stack. If nothing was captured we synthesise one
  // containing the raw body so at least something useful reaches the logs.
  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));

  // Replace the unhelpful JSON blob with the friendly HTML error page. The user
  // still gets a 500, but a readable one instead of raw internals.
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * The default export is the server itself. The runtime calls `fetch` once per
 * incoming HTTP request and sends whatever Response we return.
 */
export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // In-app API (auth) — serves /api/* in production where there is no dev
      // proxy. Returns null for non-/api paths so SSR handles everything else.
      //
      // This "return null to opt out" pattern is what makes the ordering work:
      // API routes get first refusal on every request, and anything they do not
      // claim falls through to page rendering below.
      const apiResponse = await handleApiRequest(request, env);
      if (apiResponse) return apiResponse;

      // Not an API path, so render a page. This is where React server-side
      // rendering happens and HTML is produced.
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      // The last line of defence. If we reach here the app failed in a way that
      // did throw properly. Same rule as in start.ts: log the detail on the
      // server, show the user a generic page, never leak internals.
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
