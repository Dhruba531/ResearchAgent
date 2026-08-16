// The sign-in / sign-up form.
//
// The best file in the repo for learning FORM HANDLING, because it uses the
// full stack the project standardises on:
//   • react-hook-form — tracks values, touched state, and submission
//   • zod             — declares the validation rules
//   • zodResolver     — the adapter wiring the two together
//
// Also worth reading for `sanitizeRedirect` below, which prevents a real
// security vulnerability (open redirect) in about ten lines.

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

import { ApiError, login as apiLogin, register as apiRegister } from "@/lib/api";
import { oauth } from "@/integrations/supabase/oauth";
import { Route as AuthRoute } from "@/routes/auth";

const REDIRECT_STORAGE_KEY = "agentlab.postAuthRedirect";

/** Only accept same-origin path-like redirects to avoid open-redirect. */
//
// ===========================================================================
// THE VULNERABILITY THIS PREVENTS
// ===========================================================================
// After signing in, the app sends you to `?redirect=<somewhere>`. If that value
// were trusted blindly, an attacker could send a victim a link like:
//
//     https://yourapp.com/auth?redirect=https://evil.example.com/login
//
// The victim sees a genuine, correctly-certificated link to your domain, signs
// in for real, and is then bounced to a copycat page that asks them to "sign in
// again" — harvesting the credentials. That is an OPEN REDIRECT, and it is a
// standard phishing primitive precisely because the initial link is authentic.
//
// The defence is to allow only same-origin, path-like destinations. Every check
// below is one bypass technique, and every failure funnels to the same safe
// default rather than to an error — a redirect target is never worth failing a
// login over.
function sanitizeRedirect(raw: string | undefined | null): string {
  if (!raw) return "/console";
  try {
    // Parsing with a base URL resolves relative paths while still exposing the
    // `origin` of an absolute one, so both forms can be checked uniformly.
    const url = new URL(raw, window.location.origin);
    // Blocks "https://evil.example.com/..." — a different host.
    if (url.origin !== window.location.origin) return "/console";
    const path = url.pathname + url.search + url.hash;
    // Blocks PROTOCOL-RELATIVE urls. "//evil.example.com" has no scheme, so a
    // browser reuses the current one and treats it as an absolute URL to
    // another host — it looks like a path but is not one. This is the subtle
    // check people miss.
    if (!path.startsWith("/") || path.startsWith("//")) return "/console";
    // Blocks redirecting back to /auth, which would loop the user through
    // sign-in forever rather than landing them anywhere useful.
    if (path.startsWith("/auth")) return "/console";
    return path;
  } catch {
    // `new URL()` throws on unparseable input. Malformed means untrusted.
    return "/console";
  }
}

type Mode = "login" | "register";

// ── Validation schemas ────────────────────────────────────────────────────
// zod declares the RULES; react-hook-form runs them and surfaces the messages.
// The strings passed to each validator are the errors shown to the user, so
// they are written as instructions ("Min 8 characters") rather than as
// complaints.

const loginSchema = z.object({
  // `.trim()` normalises before validating, so a stray pasted space does not
  // fail the email check. `.max()` caps length — unbounded input is a denial-
  // of-service vector as well as a storage problem.
  email: z.string().trim().email("Enter a valid email").max(255),
  // Login deliberately checks only the LENGTH, not the composition rules
  // applied at registration below. Existing accounts may predate those rules,
  // and rejecting a correct password at sign-in would lock people out.
  password: z.string().min(8, "Min 8 characters").max(128),
});

// Registration is stricter, since this is where a new password is chosen.
const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Min 2 characters").max(80),
    email: z.string().trim().email("Enter a valid email").max(255),
    // Chained rules, each with its own message, so the user is told exactly
    // which requirement is unmet rather than a generic "invalid password".
    password: z
      .string()
      .min(8, "Min 8 characters")
      .max(128)
      .regex(/[A-Z]/, "Needs an uppercase letter")
      .regex(/[0-9]/, "Needs a number"),
    // No rules of its own — its only job is to match, checked by `.refine`.
    confirm: z.string(),
  })
  // `.refine` validates ACROSS FIELDS, which per-field rules cannot do: whether
  // the two passwords match depends on both. Note it is chained onto the
  // object, not onto a field.
  //
  // `path: ["confirm"]` attaches the error to the confirm input, so the message
  // appears under the field the user needs to fix rather than at form level.
  .refine((d) => d.password === d.confirm, {
    message: "Passwords don't match",
    path: ["confirm"],
  });

// `z.infer` DERIVES the TypeScript type from the schema, so the types and the
// validation cannot drift apart. Add a field to `registerSchema` and
// `RegisterValues` gains it automatically — write the shape once, not twice.
type LoginValues = z.infer<typeof loginSchema>;
type RegisterValues = z.infer<typeof registerSchema>;

/** An inline SVG loading spinner. */
function Spinner() {
  return (
    // `currentColor` on the strokes makes the spinner inherit the surrounding
    // text colour, so it works on any button variant without being restyled.
    // `aria-hidden` hides it from screen readers — it is decorative, and the
    // button's own text already conveys the state.
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={htmlFor} className="mono-label">
          {label}
        </label>
        {hint}
      </div>
      <div className="mt-2">{children}</div>
      {/* THE ERROR SLOT, and two details worth copying:

          1. It is ALWAYS RENDERED — hidden with `opacity-0` and given a
             `min-h`, rather than conditionally mounted. So the layout reserves
             the space permanently and the form does not jump downward when an
             error appears. (The literal "placeholder" text exists only to hold
             that height open.)

          2. `aria-live="polite"` makes screen readers announce the message when
             it changes, without interrupting whatever they are currently
             reading. Without it, a sighted user sees the error and a blind user
             gets nothing. */}
      <div
        className={`mt-1.5 min-h-[14px] font-mono text-[11px] transition-opacity ${
          error ? "text-destructive opacity-100" : "opacity-0"
        }`}
        aria-live="polite"
      >
        {error ?? "placeholder"}
      </div>
    </div>
  );
}

function inputClass(invalid?: boolean) {
  return `w-full rounded-lg border bg-background/80 px-3.5 py-2.5 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary focus:ring-1 focus:ring-primary/20 ${
    invalid ? "border-destructive/70" : "border-border"
  }`;
}

export function OperatorConsole() {
  const [mode, setMode] = useState<Mode>("login");
  const navigate = useNavigate();
  const search = AuthRoute.useSearch();
  const redirectTo = sanitizeRedirect(search.redirect);

  // TWO SEPARATE FORM INSTANCES, one per mode. Keeping them independent means
  // switching tabs preserves whatever was typed in each, and the two schemas
  // stay cleanly separated.
  const loginForm = useForm<LoginValues>({
    // The adapter that runs the zod schema as react-hook-form's validator.
    resolver: zodResolver(loginSchema),
    // Validate when a field LOSES FOCUS. The deliberate middle ground:
    // "onChange" would flag an email as invalid while it is still being typed,
    // and "onSubmit" would withhold all feedback until the end.
    mode: "onBlur",
    // Empty strings, not undefined — this is what makes the inputs CONTROLLED
    // from the first render. Starting undefined and later setting a value makes
    // React warn about switching an input from uncontrolled to controlled.
    defaultValues: { email: "", password: "" },
  });

  const registerForm = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    mode: "onBlur",
    defaultValues: { name: "", email: "", password: "", confirm: "" },
  });

  const submitLogin = async (values: LoginValues) => {
    try {
      const user = await apiLogin(values.email, values.password);
      toast.success("Authenticated", {
        description: `Welcome ${user.name} — routing to control room…`,
      });
      await navigate({ to: redirectTo });
    } catch (e) {
      // A SERVER-side failure surfaced through the same channel as a validation
      // error, so it renders in the field's error slot rather than as a toast.
      // Attached to `password` because that is the field the user would retype.
      //
      // The `instanceof ApiError` test distinguishes "the server rejected these
      // credentials" from "the server could not be reached" — a distinction
      // that changes what the user should do next. This is the payoff of the
      // custom error class in lib/api.ts.
      loginForm.setError("password", {
        message: e instanceof ApiError ? e.message : "Could not reach the server.",
      });
    }
  };

  const submitRegister = async (values: RegisterValues) => {
    try {
      const user = await apiRegister(values.name, values.email, values.password);
      toast.success("Access granted", {
        description: `Welcome ${user.name} — routing to control room…`,
      });
      await navigate({ to: redirectTo });
    } catch (e) {
      registerForm.setError("email", {
        message: e instanceof ApiError ? e.message : "Could not reach the server.",
      });
    }
  };

  // `isSubmitting` is tracked BY react-hook-form — no manual `setBusy(true)` /
  // `finally { setBusy(false) }` around each submit, as the hand-rolled
  // mutations in governance.tsx need. The library owns the async lifecycle.
  const loginBusy = loginForm.formState.isSubmitting;
  const registerBusy = registerForm.formState.isSubmitting;
  // Google sign-in is NOT a form submission, so its loading state is manual.
  const [googleBusy, setGoogleBusy] = useState(false);

  const signInWithGoogle = async () => {
    setGoogleBusy(true);
    try {
      // Persist the intended destination for the full-page redirect flow —
      // consumed on return by the root supabase auth listener.
      //
      // Necessary because OAuth performs a FULL PAGE NAVIGATION to Google and
      // back. All React state is destroyed in the process, so the destination
      // has to survive outside the app — sessionStorage is the right store,
      // since it clears when the tab closes. `__root.tsx` reads it on return.
      //
      // Wrapped in try/catch because storage throws in private browsing. Losing
      // the redirect only means landing on the default page, which is a far
      // better outcome than failing the sign-in.
      try {
        window.sessionStorage.setItem(REDIRECT_STORAGE_KEY, redirectTo);
      } catch {
        // ignore storage errors
      }
      // Hands off to Supabase Auth, which runs the OAuth handshake and writes
      // the resulting session itself.
      const result = await oauth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        toast.error("Google sign-in failed", {
          description: result.error instanceof Error ? result.error.message : "Try again.",
        });
        setGoogleBusy(false);
        return;
      }
      // The browser is navigating away to Google. Note `setGoogleBusy(false)`
      // is deliberately NOT called here — leaving the spinner running is
      // correct, because the page is about to be replaced and clearing it would
      // briefly flash the button back to its idle state.
      if (result.redirected) return;
      toast.success("Authenticated", { description: "Routing to control room…" });
      try {
        window.sessionStorage.removeItem(REDIRECT_STORAGE_KEY);
      } catch {
        // ignore
      }
      await navigate({ to: redirectTo });
    } catch (e) {
      toast.error("Google sign-in failed", {
        description: e instanceof Error ? e.message : "Try again.",
      });
      setGoogleBusy(false);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card p-6">
      {/* status strip */}
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <span className="mono-label flex min-w-0 items-center gap-2 truncate">
          <span className="dot bg-primary shrink-0" />
          operator console
        </span>
        <div
          className="relative flex w-full shrink-0 rounded-lg border border-border p-0.5 font-mono text-[11px] tracking-wider sm:w-auto"
          role="tablist"
        >
          {/* The sliding highlight behind the active tab. It is one absolutely
              positioned element that TRANSLATES between the two positions,
              rather than a background toggled on each button — that is what
              produces the smooth animation.

              Animating `transform` (rather than `left`) keeps the work on the
              GPU compositor, so it stays at 60fps without triggering layout.
              `aria-hidden` because it is purely decorative; the real state is
              carried by `aria-selected` on the buttons below. */}
          <span
            className="absolute inset-y-0.5 w-[calc(50%-2px)] rounded-md border border-border bg-background/80 transition-transform duration-300 ease-out"
            style={{ transform: mode === "login" ? "translateX(0%)" : "translateX(100%)" }}
            aria-hidden
          />
          {/* `as const` narrows the array to the literal tuple
              `readonly ["login", "register"]`, so `m` is typed `Mode` rather
              than `string` — which is what lets `setMode(m)` type-check. */}
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              // `role="tab"` + `aria-selected` tell assistive technology this is
              // a tab set and which one is active. Needed here because these
              // are hand-rolled buttons rather than Radix Tabs, which would
              // supply the ARIA wiring itself.
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`relative z-10 flex-1 px-4 py-1.5 transition-colors sm:flex-none ${
                mode === m ? "text-foreground" : "text-muted-foreground hover:text-foreground/80"
              }`}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Google sign-in */}
      <div className="mt-6">
        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={googleBusy || loginBusy || registerBusy}
          className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-background/60 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-background disabled:opacity-70"
        >
          {googleBusy ? (
            <>
              <Spinner /> Connecting to Google…
            </>
          ) : (
            <>
              <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.28-1.93-6.15-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/>
                <path fill="#FBBC05" d="M5.85 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.67-2.84Z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.67 2.84C6.72 7.31 9.14 5.38 12 5.38Z"/>
              </svg>
              Continue with Google
            </>
          )}
        </button>
        <div className="mt-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-border/60" />
          <span className="font-mono text-[10px] tracking-wider text-muted-foreground/70">
            OR CONTINUE WITH EMAIL
          </span>
          <span className="h-px flex-1 bg-border/60" />
        </div>
      </div>

      {/* forms with crossfade */}
      <div className="relative mt-6">

        {mode === "login" ? (
          <form
            key="login"
            onSubmit={loginForm.handleSubmit(submitLogin)}
            className="space-y-1 animate-in fade-in slide-in-from-left-2 duration-300"
            noValidate
          >
            <Field
              label="Email"
              htmlFor="login-email"
              error={loginForm.formState.errors.email?.message}
            >
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                disabled={loginBusy}
                className={inputClass(!!loginForm.formState.errors.email)}
                {...loginForm.register("email")}
              />
            </Field>
            <Field
              label="Password"
              htmlFor="login-password"
              error={loginForm.formState.errors.password?.message}
              hint={
                <button
                  type="button"
                  className="font-mono text-[11px] text-primary hover:underline"
                  onClick={() => toast("Reset link sent if the email exists.")}
                >
                  Forgot?
                </button>
              }
            >
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                disabled={loginBusy}
                className={inputClass(!!loginForm.formState.errors.password)}
                {...loginForm.register("password")}
              />
            </Field>

            <button
              type="submit"
              disabled={loginBusy}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-all hover:opacity-95 disabled:opacity-70"
            >
              {loginBusy ? (
                <>
                  <Spinner /> Authenticating…
                </>
              ) : (
                <>Sign in</>
              )}
            </button>
          </form>
        ) : (
          <form
            key="register"
            onSubmit={registerForm.handleSubmit(submitRegister)}
            className="space-y-1 animate-in fade-in slide-in-from-right-2 duration-300"
            noValidate
          >
            <Field
              label="Full name"
              htmlFor="reg-name"
              error={registerForm.formState.errors.name?.message}
            >
              <input
                id="reg-name"
                disabled={registerBusy}
                className={inputClass(!!registerForm.formState.errors.name)}
                {...registerForm.register("name")}
              />
            </Field>
            <Field
              label="Work email"
              htmlFor="reg-email"
              error={registerForm.formState.errors.email?.message}
            >
              <input
                id="reg-email"
                type="email"
                autoComplete="email"
                disabled={registerBusy}
                className={inputClass(!!registerForm.formState.errors.email)}
                {...registerForm.register("email")}
              />
            </Field>
            <Field
              label="Password"
              htmlFor="reg-password"
              error={registerForm.formState.errors.password?.message}
            >
              <input
                id="reg-password"
                type="password"
                autoComplete="new-password"
                disabled={registerBusy}
                className={inputClass(!!registerForm.formState.errors.password)}
                {...registerForm.register("password")}
              />
            </Field>
            <Field
              label="Confirm"
              htmlFor="reg-confirm"
              error={registerForm.formState.errors.confirm?.message}
            >
              <input
                id="reg-confirm"
                type="password"
                autoComplete="new-password"
                disabled={registerBusy}
                className={inputClass(!!registerForm.formState.errors.confirm)}
                {...registerForm.register("confirm")}
              />
            </Field>

            <button
              type="submit"
              disabled={registerBusy}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-all hover:opacity-95 disabled:opacity-70"
            >
              {registerBusy ? (
                <>
                  <Spinner /> Provisioning…
                </>
              ) : (
                <>Create account</>
              )}
            </button>
          </form>
        )}
      </div>

      <div className="mt-5 text-center font-mono text-[10px] tracking-wider text-muted-foreground/70">
        session cookie · httpOnly · sameSite=none
      </div>


      {/* busy overlay shimmer */}
      {(loginBusy || registerBusy) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] overflow-hidden">
          <div className="h-full w-1/3 animate-[slide_1.1s_ease-in-out_infinite] bg-primary" />
        </div>
      )}

      <style>{`
        @keyframes slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}
