// Captures the original Error out-of-band so server.ts can recover the stack
// when h3 has already swallowed the throw into a generic 500 Response.
//
// "Out-of-band" is the key idea. Normally you propagate an error by throwing it
// and catching it upstream. That path is unavailable here — h3 intercepts the
// throw before server.ts can see it. So this module takes a side channel: it
// listens for errors globally, stashes the most recent one in a module variable,
// and lets server.ts collect it afterwards.
//
// This is a deliberate use of mutable global state. It is justified only because
// the normal mechanism is genuinely blocked; do not reach for this pattern when
// an ordinary throw/catch would work.

// The single slot. `at` records when the error arrived — see the TTL logic in
// `consumeLastCapturedError` for why the timestamp is needed.
let lastCapturedError: { error: unknown; at: number } | undefined;

// How long a captured error stays valid. Numeric separators (the underscore in
// 5_000) are ignored by JavaScript and exist purely to make long numbers
// readable — this is 5000 milliseconds.
const TTL_MS = 5_000;

function record(error: unknown) {
  // Deliberately overwrites any previous error rather than queueing. We only
  // ever want the most recent one, since server.ts asks for it immediately
  // after a failure.
  lastCapturedError = { error, at: Date.now() };
}

// Feature-detect before registering. This code runs in several JavaScript
// runtimes — Node, Cloudflare Workers, the Vite dev server — and not all of
// them expose `addEventListener` on the global object. Calling it blindly would
// crash at import time, which would take down the whole server.
if (typeof globalThis.addEventListener === "function") {
  // Two listeners, because JavaScript reports failure in two distinct ways:

  // "error" fires for synchronous exceptions that reach the top of the stack.
  // The `.error` property holds the actual Error object; the `?? event` fallback
  // covers runtimes that fire a bare event without it, so we record something
  // rather than undefined.
  globalThis.addEventListener("error", (event) => record((event as ErrorEvent).error ?? event));

  // "unhandledrejection" fires for a rejected Promise that nobody caught. These
  // never trigger the "error" event, so without this second listener every
  // async failure — which in an SSR app is most of them — would be missed.
  // The rejection value lives on `.reason`.
  globalThis.addEventListener("unhandledrejection", (event) =>
    record((event as PromiseRejectionEvent).reason),
  );
}

/**
 * Retrieve and clear the last captured error.
 *
 * "Consume" is in the name because reading has a side effect: the error is
 * removed. That is intentional and important — it guarantees an error is
 * reported at most once. Without clearing, a stale error from an earlier
 * request could be attached to a later, unrelated failure and send you
 * debugging the wrong thing entirely.
 */
export function consumeLastCapturedError(): unknown {
  if (!lastCapturedError) return undefined;

  // The TTL guards against exactly that kind of mismatch. If the stored error is
  // older than 5 seconds it almost certainly belongs to a different request, so
  // discard it and report nothing rather than report something misleading.
  if (Date.now() - lastCapturedError.at > TTL_MS) {
    lastCapturedError = undefined;
    return undefined;
  }

  // Read the value out into a local BEFORE clearing the slot, then return the
  // local. Clearing first would discard the very thing we are trying to return.
  const { error } = lastCapturedError;
  lastCapturedError = undefined;
  return error;
}
