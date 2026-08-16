// Provider OAuth sign-in, run through Supabase Auth.
//
// Supabase owns the whole handshake: it redirects the browser to the provider,
// handles the callback, and writes the session into its own store. There is no
// second auth system to stitch together afterwards — on return, the auth
// listener in `__root.tsx` already sees a signed-in user.
//
// Configure the provider and its redirect URL in the Supabase dashboard under
// Authentication → Providers, or the callback will be rejected.

import { supabase } from "./client";

/**
 * `redirect_uri` — where to send the user once the provider approves them.
 * `extraParams` — extra query parameters for the provider's auth URL (scopes,
 * prompt behaviour, and so on). Both optional.
 */
type SignInOptions = {
  redirect_uri?: string;
  extraParams?: Record<string, string>;
};

export const oauth = {
  /**
   * Start an OAuth sign-in.
   *
   * The `provider` parameter is a literal union, so only these strings are
   * accepted — the compiler catches a typo like "gooogle" immediately.
   */
  signInWithOAuth: async (provider: "google" | "apple" | "azure", opts?: SignInOptions) => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: opts?.redirect_uri,
        queryParams: opts?.extraParams,
      },
    });

    // Failure: no navigation happened, so the caller stays on the page and
    // needs to surface the message.
    if (error) return { redirected: false, error };

    // Success means the browser is navigating away to the provider. This
    // JavaScript context is about to be discarded, so report the redirect and
    // let the caller leave its spinner running.
    return { redirected: true, error: undefined };
  },
};
