// THE RECEIVING HALF of the auth handshake begun in `auth-attacher.ts`. That
// file (running in the browser) attaches a bearer token to the request; this
// file (running on the server) verifies it and establishes who is calling.
//
// The client half is registered globally in start.ts, so it runs for every
// server function. This half is OPT-IN — a server function must explicitly list
// `requireSupabaseAuth` in its middleware to be protected. The asymmetry is
// intentional: always send the token if we have one, but let each endpoint
// decide whether it requires one.
//
// Key insight for the whole file: the client it builds is authenticated AS THE
// USER, so RLS still applies. That makes it the safe counterpart to
// `client.server.ts`, which bypasses RLS entirely.

import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'



// `.server(...)` — this callback runs only on the server. Compare `.client(...)`
// in auth-attacher.ts.
export const requireSupabaseAuth = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {

    // The publishable (anon) key, NOT the service role key. That choice is what
    // keeps row-level security in force for everything done through the client
    // built below. See client.server.ts for why that distinction matters.
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      // Same conditional-spread idiom as the client files; see client.ts.
      const missing = [
        ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
        ...(!SUPABASE_PUBLISHABLE_KEY ? ['SUPABASE_PUBLISHABLE_KEY'] : []),
      ];
      const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Set them in your .env.`;
      console.error(`[Supabase] ${message}`);
      throw new Error(message);
    }

    // Reaches into TanStack Start's per-request context to get the incoming
    // HTTP request. This works without the request being passed down as an
    // argument because Start keeps it in async-local storage for the duration of
    // the request.
    const request = getRequest();

    // ------------------------------------------------------------------
    // A ladder of guards. Each one throws rather than returning, so control
    // never reaches the trusted code below unless every check passed. Writing
    // it as sequential early-exits (rather than nested ifs) keeps the happy
    // path flat and makes each failure reason distinct in the logs.
    //
    // Worth noting: these messages are deliberately specific for debugging, but
    // none of them leak whether a given user or token *exists* — they only
    // describe the shape of what was received.
    // ------------------------------------------------------------------

    if (!request?.headers) {
      throw new Error('Unauthorized: No request headers available');
    }

    const authHeader = request.headers.get('authorization');

    // No header at all — an unauthenticated caller. Recall the attacher sends
    // `{}` when signed out, which lands here.
    if (!authHeader) {
      throw new Error('Unauthorized: No authorization header provided');
    }

    // Enforce the scheme. Rejecting anything that is not `Bearer ` prevents
    // confusion with other schemes (Basic, Digest) that must not be honoured.
    if (!authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized: Only Bearer tokens are supported');
    }

    // Strip the prefix to get the raw JWT. (`replace` with a string argument
    // replaces the first occurrence only, which is what we want here — the
    // `startsWith` check above already guaranteed it is at the front.)
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized: No token provided');
    }

    // Build a per-request client that acts AS THIS USER. The `global.headers`
    // option makes every query issued through this client carry the user's
    // token, so Postgres evaluates RLS policies against their identity.
    //
    // This is created fresh per request rather than being a module-level
    // singleton — it has to be, since each request carries a different user's
    // token. A shared instance would leak one user's access to another.
    const supabase = createClient<Database>(
      // The `!` non-null assertions are redundant here: the guard above already
      // narrowed both to strings. Harmless, but not something to copy.
      SUPABASE_URL!,
      SUPABASE_PUBLISHABLE_KEY!,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        auth: {
          // No persistence — same reasoning as client.server.ts. This client
          // exists for one request and is then discarded.
          storage: undefined,
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    // THE ACTUAL VERIFICATION. Everything above only checked the token's SHAPE;
    // this is what proves it is genuine. `getClaims` validates the JWT's
    // cryptographic signature and its expiry. Skipping this and merely decoding
    // the token would be a critical vulnerability — anyone can hand-craft a JWT
    // claiming to be any user, and only the signature check catches it.
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims) {
      // Note the vague message compared to the specific ones above. Once we are
      // past shape-checking, refusing to say *why* a token was rejected
      // (expired? bad signature? unknown user?) gives an attacker nothing to
      // work with.
      throw new Error('Unauthorized: Invalid token');
    }

    // `sub` ("subject") is the standard JWT claim holding the user's ID. A
    // valid token without one would leave us authenticated as nobody, so treat
    // it as a failure rather than proceeding with an undefined user.
    if (!data.claims.sub) {
      throw new Error('Unauthorized: No user ID found in token');
    }

    // Pass control to the actual server function, injecting the verified
    // identity into its context. Anything placed here is available to the
    // handler — which is the payoff of the whole file: by the time your
    // function body runs, `context.userId` is a *verified* user ID, not a
    // client-supplied claim you still need to be suspicious of.
    return next({
      context: {
        supabase,          // RLS-scoped client, ready to query as this user
        userId: data.claims.sub,
        claims: data.claims, // full JWT payload: email, role, expiry, etc.
      },
    });
  },
);
