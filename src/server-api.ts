// The deployed app talks to a real FastAPI backend via VITE_API_BASE. This
// Worker has no built-in API surface; any /api/* request returns a clean
// JSON 404 so the SPA's data calls fail predictably instead of receiving
// HTML. Non-/api paths return null so SSR handles them.
//
// Why bother having this at all, rather than just letting /api/* 404 normally?
// Because the default 404 from the SSR handler is an HTML page. Client code
// calling `fetch("/api/...").then(r => r.json())` would then blow up with
// "Unexpected token '<'" — a confusing parse error that points at JSON parsing
// rather than at the real problem (no backend configured). Returning JSON with
// an explanatory message means the failure reads correctly in the network tab
// and in any error surfaced to the user.

export async function handleApiRequest(request: Request, _env: unknown): Promise<Response | null> {
  // `new URL(...)` parses the full request URL so we can look at just the path,
  // ignoring the protocol, host, and query string.
  const url = new URL(request.url);

  // Returning `null` is this function's way of saying "not mine — carry on".
  // server.ts checks for a falsy result and falls through to SSR. The leading
  // and trailing slashes in "/api/" matter: they stop a path like "/apidocs"
  // from being captured here.
  if (!url.pathname.startsWith("/api/")) return null;

  // The `_env` parameter is unused. The underscore prefix is a convention (and
  // an ESLint configuration) signalling "intentionally ignored" — it keeps the
  // parameter in position so the signature still matches what server.ts passes,
  // without tripping the no-unused-vars rule.
  return new Response(
    JSON.stringify({
      // "detail" is FastAPI's standard error key. Matching that shape means the
      // client's existing error handling works whether the response came from
      // this stub or from the real backend.
      detail: "This app has no built-in API. Configure a backend via VITE_API_BASE.",
    }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}
