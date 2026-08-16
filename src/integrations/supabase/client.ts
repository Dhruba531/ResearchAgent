// This is the BROWSER-side Supabase client. There is a separate server-side one
// in `client.server.ts`; read that file's header for why the split exists and
// which to reach for. The short version: this one acts as the logged-in user
// and is subject to database row-level security. That is the one you want
// almost everywhere.
//
// The interesting part of this file is the Proxy at the bottom.

import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

function createSupabaseClient() {
  // Use import.meta.env for client-side (Vite build-time replacement)
  // Fall back to process.env for SSR (server-side rendering)
  //
  // Two different mechanisms because two different runtimes:
  //
  // `import.meta.env.VITE_*` is not a runtime lookup at all — Vite performs a
  // literal text substitution at BUILD time, so the shipped bundle contains the
  // string value inlined. This is also why the `VITE_` prefix is mandatory:
  // Vite only inlines variables carrying it, which prevents your entire server
  // environment (database passwords included) from being baked into a public
  // JavaScript bundle by accident.
  //
  // `process.env` is a genuine runtime lookup, available only in Node during
  // server-side rendering. The `||` chain tries the build-time value first and
  // falls back to the runtime one, so a single module works in both places.
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    // Build the list of what is actually missing, so the error names the exact
    // variable(s) rather than saying "configuration error".
    //
    // The idiom `...(condition ? ['x'] : [])` is conditional spreading: spread
    // a one-element array when the condition holds, or an empty array when it
    // does not. Spreading `[]` contributes nothing, so this appends the name
    // only when that variable is absent. It is a common way to build an array
    // conditionally without `if` statements or `.filter(Boolean)`.
    const missing = [
      ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY ? ['SUPABASE_PUBLISHABLE_KEY'] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Set them in your .env.`;
    // Logged AND thrown deliberately: the log guarantees it reaches the console
    // even if some caller swallows the exception.
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  // `createClient<Database>` — the generic parameter is what makes every query
  // in this app type-safe. `Database` (from ./types) describes your real table
  // and column names, so `.from("campaigns").select("nmae")` is a compile error
  // rather than a runtime surprise. Those types are generated from the actual
  // schema; regenerate them whenever you change the database.
  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      // `localStorage` only exists in a browser. During SSR we pass `undefined`,
      // which tells Supabase not to persist anything — correct, since the server
      // has no single user to store a session for.
      storage: typeof window !== 'undefined' ? localStorage : undefined,
      // Keeps the session in storage across page reloads, so users are not
      // signed out every time they refresh.
      persistSession: true,
      // Refreshes the access token in the background before it expires, so long
      // sessions do not suddenly start failing with 401s.
      autoRefreshToken: true,
    }
  });
}

// Holds the single client instance once created. The leading underscore is a
// convention meaning "private to this module" — it is not exported.
let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
//
// LAZY INITIALISATION VIA PROXY. This deserves an explanation, because it is
// the least obvious code in the file.
//
// The problem: `createSupabaseClient()` throws when environment variables are
// missing. If this module simply did `export const supabase = createSupabaseClient()`,
// that throw would happen at IMPORT time — the instant anything imported this
// file, before any of your code ran. During SSR that crashes the entire server
// on startup, with a stack trace pointing at an import statement rather than at
// whatever actually needed the database.
//
// The fix: export a Proxy — an object that intercepts operations performed on
// it. This one traps property reads via its `get` handler. The real client is
// not built until someone first touches a property (`supabase.auth`,
// `supabase.from`, …), by which point we are inside real application code where
// an error can be caught and reported sensibly.
//
// `{} as ReturnType<typeof createSupabaseClient>` is the target: an empty object
// asserted to have the client's type, purely so TypeScript gives correct
// autocomplete. Nothing is ever read from that empty object — the `get` trap
// intercepts every access before it gets there.
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    // Create on first access, then reuse. This memoisation is what keeps it a
    // singleton — otherwise every property read would build a new client.
    if (!_supabase) _supabase = createSupabaseClient();
    // Forward the property read to the real client. `Reflect.get` rather than
    // `_supabase[prop]` because it correctly forwards `receiver`, which matters
    // for getters that rely on `this` being bound properly.
    return Reflect.get(_supabase, prop, receiver);
  },
});

