// THE SENDING HALF of the auth handshake. Its partner is `auth-middleware.ts`,
// which is the receiving half. Read them together:
//
//   [browser]  auth-attacher.ts    reads the session, attaches "Authorization:
//                                  Bearer <token>" to the outgoing request
//                       │
//                       ▼  (network)
//   [server]   auth-middleware.ts  reads that header, verifies the token,
//                                  and puts the user's identity into context
//
// Note the `.client(...)` call below versus `.server(...)` in the middleware —
// that single method name is what decides which side of the wire each file runs
// on.

import { createMiddleware } from '@tanstack/react-start'
import { supabase } from './client'

// Must be registered as a global `functionMiddleware` in `src/start.ts`; otherwise
// the browser never attaches the bearer token to serverFn RPCs.
//
// "Global" is the important word: registering it once in start.ts means EVERY
// server function gets the token automatically. That is why the ~95 functions in
// `src/lib/api.ts` can each assume an authenticated caller without a single one
// of them repeating this code.
export const attachSupabaseAuth = createMiddleware({ type: 'function' }).client(
  async ({ next }) => {
    // `getSession()` reads the session Supabase persisted in localStorage (see
    // `persistSession: true` in client.ts). It does not hit the network, so
    // this adds no latency to the call it is wrapping.
    const { data } = await supabase.auth.getSession()

    // Optional chaining, because a signed-out user has no session at all —
    // `data.session` is null and this yields undefined rather than throwing.
    const token = data.session?.access_token

    // `next()` continues to the actual server function; whatever headers we
    // pass here are merged into the outgoing request.
    return next({
      // Sending `{}` for a signed-out user is deliberate rather than an
      // oversight. Not every server function requires auth, so we do not block
      // the call here — we simply send nothing. The server side decides whether
      // a missing token is acceptable, which keeps the policy in one place.
      // "Bearer" is the standard scheme name from RFC 6750; the server checks
      // for that exact prefix.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  },
)
