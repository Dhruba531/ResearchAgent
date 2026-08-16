// Server-side Supabase client with service role key - bypasses RLS.
// Use this for admin operations in server functions and server routes only.
// For user-authenticated queries (with RLS), use the auth middleware instead.
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE USING ANYTHING IN THIS FILE
// ---------------------------------------------------------------------------
// This is the DANGEROUS twin of `client.ts`. Structurally the two files are
// nearly identical; the difference is which key they authenticate with, and
// that difference is enormous.
//
// RLS (Row-Level Security) is Postgres enforcing access rules inside the
// database itself. With RLS on, a query like `select * from campaigns` returns
// only the rows the current user is allowed to see — the database applies the
// filter, so a bug in application code cannot leak another user's data.
//
//   client.ts        → publishable key → RLS ENFORCED  → sees only its own rows
//   client.server.ts → service role key → RLS BYPASSED → sees EVERY row
//
// The service role key is effectively the database superuser. Any query made
// through this client ignores every access rule you have written. Two hard
// consequences:
//
//   1. This key must NEVER reach the browser. Note it is read from
//      `process.env` with no `VITE_` prefix, unlike client.ts — that prefix is
//      exactly what would cause Vite to inline the value into the public
//      bundle. Its absence is a deliberate safeguard.
//
//   2. Because the database will no longer check permissions for you, any code
//      using this client must do the checking itself — verify who is calling
//      and filter to what they may see, explicitly, in every query.
//
// Default to `client.ts`. Reach for this only when an operation genuinely must
// cross user boundaries (background jobs, admin tooling, aggregate reporting).

import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

function createSupabaseAdminClient() {
  // `process.env` only — no `import.meta.env` fallback, unlike client.ts. That
  // asymmetry is the safeguard described above: there is deliberately no path
  // by which this key can be inlined into client-side JavaScript.
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Same conditional-spread idiom as client.ts — see that file for the
    // explanation of `...(cond ? ['x'] : [])`.
    const missing = [
      ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
      ...(!SUPABASE_SERVICE_ROLE_KEY ? ['SUPABASE_SERVICE_ROLE_KEY'] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Set them in your .env.`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // All three auth options are the exact opposite of client.ts, and for a
      // good reason. A browser client represents ONE user whose session should
      // survive reloads. This client represents no user at all — it is a
      // privileged connection shared across every request the server handles.
      //
      // Persisting a session here would be both meaningless and hazardous: it
      // would mean one request's auth state could bleed into another's.
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    }
  });
}

let _supabaseAdmin: ReturnType<typeof createSupabaseAdminClient> | undefined;

// Server-side Supabase client with service role - bypasses RLS
// SECURITY: Only use this for trusted server-side operations, never expose to client code
// Load inside server handlers: const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
// Top-level import is safe only in other .server.ts modules - route files and *.functions.ts ship to the client bundle.
//
// That last line is the critical operational rule, so to spell it out:
//
// A top-level `import { supabaseAdmin } from "./client.server"` in a route file
// makes the bundler include this module in the CLIENT bundle. Even if the code
// never runs in the browser, the module is now shipped — and with it, the
// reference to the service-role key. Use the dynamic `await import(...)` form
// shown above inside server-only handlers; a dynamic import is resolved at
// runtime on the server and never pulled into the client build.
//
// The Proxy below is the same lazy-initialisation trick as client.ts (see the
// long explanation there): defer creation until first property access so a
// missing environment variable does not crash the server at import time.
export const supabaseAdmin = new Proxy({} as ReturnType<typeof createSupabaseAdminClient>, {
  get(_, prop, receiver) {
    if (!_supabaseAdmin) _supabaseAdmin = createSupabaseAdminClient();
    return Reflect.get(_supabaseAdmin, prop, receiver);
  },
});
