// AgentLab API client — talks to the real FastAPI backend.
// There is no mock/demo backend: every run spends real provider credits.
//
// Base URL resolution order (runtime):
//   1. localStorage["agentlab_api_base"] — set by the Console → Agent connection panel
//   2. import.meta.env.VITE_API_BASE     — build-time default
//   3. ""                                — same-origin (no backend configured)
//
// Every request uses `credentials: "include"` so the backend's HttpOnly,
// SameSite=None, Secure session cookie survives cross-origin fetches.
//
// ===========================================================================
// HOW TO READ THIS FILE (842 lines, ~95 exports)
// ===========================================================================
// This is the DATA LAYER for the whole application. Every piece of campaign,
// candidate, and run data in the UI arrives through a function defined here.
// (Supabase handles only authentication — its schema has no tables. See
// `src/integrations/supabase/types.ts`.)
//
// Do NOT read this top to bottom. It is wide, not deep: a small core of shared
// machinery followed by many thin, near-identical wrappers. Understand the core
// and the rest is self-explanatory.
//
// THE CORE (worth reading carefully — everything else depends on it):
//   getApiBase()   where requests are sent, and how that is configured
//   ApiError       the error type thrown on any non-2xx response
//   request<T>()   the single function every REST call goes through
//
// THE REST, organised into `// ---- Section ----` blocks:
//   • `interface XxxOut` declarations — the shapes the backend returns. These
//     mirror the Python models in backend/schemas.py. The `Out` suffix means
//     "output from the server". They are hand-maintained, so if the backend
//     changes its response shape, nothing here catches the drift automatically.
//   • one-line endpoint wrappers, nearly all of the form
//        export const doThing = (arg) => request<ResultType>("/api/path")
//     Once you have read `request`, each of these is fully described by its
//     name, its argument, and its `<T>`.
//
// The genuinely different parts, worth finding: `openRunLogs` and
// `openSearchTrace` near the bottom use WebSockets rather than fetch, and the
// Auth section routes through Supabase instead of the FastAPI backend.

import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

// The localStorage key holding a user-configured backend URL. Named as a
// constant so the reader and writer below cannot disagree about the spelling.
const API_BASE_STORAGE_KEY = "agentlab_api_base";

// Normalise a base URL: drop surrounding whitespace (users paste URLs with
// stray spaces) and any single trailing slash, so joining `base + "/api/x"`
// cannot produce a double slash.
function trimBase(u: string): string {
  return u.trim().replace(/\/$/, "");
}

/**
 * Resolve the backend base URL, applying the precedence documented at the top
 * of this file: localStorage first, then the build-time env var, then "".
 *
 * localStorage wins over the environment variable so a user can point the app
 * at their own backend from the Console UI without rebuilding — useful for
 * local development against a staging deployment.
 */
export function getApiBase(): string {
  // localStorage does not exist during server-side rendering.
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(API_BASE_STORAGE_KEY);
      // Check `.trim()` truthiness, not just presence — a stored value of "  "
      // is meaningless and should fall through to the env default rather than
      // being used as a base URL.
      if (stored && stored.trim()) return trimBase(stored);
    } catch {
      /* SSR / storage disabled */
      // The try/catch is necessary beyond the `window` check above: browsers
      // throw on localStorage access in private mode or when the user has
      // blocked site data. Swallowing that and falling through to the env
      // default is the right recovery — a storage failure should not break the
      // app's ability to reach its default backend.
    }
  }
  const envBase = import.meta.env.VITE_API_BASE as string | undefined;
  // `?? ""` means an unconfigured app requests same-origin paths, which the
  // stub in `src/server-api.ts` answers with an explanatory JSON 404.
  return trimBase(envBase ?? "");
}

/** Persist a user-supplied backend URL (or clear it when given an empty one). */
export function setApiBase(url: string): void {
  if (typeof window === "undefined") return;
  const cleaned = trimBase(url);
  // Storing "" would make `getApiBase` return an empty string forever, masking
  // the env default. Removing the key instead restores the fallback chain — so
  // clearing the field in the UI genuinely resets to the default.
  if (cleaned) window.localStorage.setItem(API_BASE_STORAGE_KEY, cleaned);
  else window.localStorage.removeItem(API_BASE_STORAGE_KEY);
}

export function clearApiBase(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(API_BASE_STORAGE_KEY);
}

/** True when a backend base URL is configured. */
export function hasRealBackend(): boolean {
  // Used by the UI to show a "connect a backend" state instead of firing
  // requests that are guaranteed to fail.
  return getApiBase().length > 0;
}

/**
 * Error type thrown by `request` for any non-2xx response.
 *
 * Subclassing the built-in `Error` lets callers distinguish an API failure from
 * any other exception with `if (err instanceof ApiError)`, and gives them the
 * HTTP status to branch on — 401 means sign in again, 404 means show an empty
 * state, 500 means show a retry button. A plain `Error` would force callers to
 * parse the message string, which is fragile.
 */
export class ApiError extends Error {
  status: number;
  body: unknown; // The parsed error body, when the server sent JSON.
  constructor(status: number, message: string, body: unknown = null) {
    // `super(message)` must come first in a subclass constructor — `this` is
    // not available until the parent constructor has run.
    super(message);
    this.status = status;
    this.body = body;
    // Set explicitly because subclassing Error does not update `name`
    // automatically; without this, logs would say "Error" instead of "ApiError".
    this.name = "ApiError";
  }
}

/**
 * The single function every REST call in this file goes through.
 *
 * `<T>` is a GENERIC type parameter — the caller declares what shape they
 * expect back, and the return type follows. `request<UserOut>("/api/me")`
 * resolves to `Promise<UserOut>`.
 *
 * Note this is a promise, not a guarantee: nothing validates that the server
 * actually sent a `UserOut`. The final `JSON.parse(text) as T` is an unchecked
 * assertion. That is a deliberate trade-off for concision here — contrast
 *
 * Not exported: it is internal plumbing, and every endpoint below wraps it.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {

  const base = getApiBase();
  const res = await fetch(`${base}${path}`, {
    // Send cookies even on cross-origin requests. This is what carries the
    // backend's session cookie, and without it every authenticated call would
    // 401 — the browser omits cookies cross-origin by default.
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    // CAREFUL: `...init` spreads LAST, so a caller passing `headers` in `init`
    // replaces the merged headers object above rather than adding to it — the
    // Content-Type default is silently lost. The `...(init.headers ?? {})` on
    // the line above compensates by merging them in first, so the common case
    // works. The alternative is to avoid the hazard entirely by
    // spreading `init` first and its merged headers last.
    ...init,
  });

  if (!res.ok) {
    // Build the most useful error message available, degrading gracefully:
    // FastAPI's `detail` field → a generic `message` field → the bare status.
    let detail = `Request failed (${res.status})`;
    let bodyJson: unknown = null;
    try {
      bodyJson = await res.json();
      const b = bodyJson as { detail?: unknown; message?: unknown };
      // `detail` is FastAPI's convention. It is usually a string, but for
      // validation errors it is an array of field-level objects — hence the
      // `typeof` check, which stringifies the structured form rather than
      // rendering the useless "[object Object]".
      if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
      else if (b?.message) detail = String(b.message);
    } catch {
      /* non-JSON error body */
      // A proxy or gateway may return an HTML error page. Keep the generic
      // message rather than letting a parse failure mask the real HTTP status.
    }
    // The raw body is attached to the error so callers can inspect structured
    // validation details that do not survive being flattened into a message.
    throw new ApiError(res.status, detail, bodyJson);
  }

  // 204 No Content is success with an empty body by definition — calling
  // `.json()` on it would throw.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // Belt-and-braces: some endpoints return 200 with an empty body.
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
  // Note both empty-body paths return `undefined as T`, which lies to the type
  // system — `T` is whatever the caller asked for, not undefined. It works
  // because callers of void-ish endpoints ignore the result, but it is why you
  // should not trust the declared return type of an endpoint that can 204.
}

// ---- Response shapes (mirror backend/schemas.py) --------------------------
//
// Everything from here on is either a response-shape interface or a thin
// endpoint wrapper. "Mirror backend/schemas.py" is the key phrase: these
// interfaces are hand-written copies of the backend's Python models, kept in
// sync MANUALLY. Nothing verifies the match at build time or at runtime, so if
// the backend renames a field, TypeScript will keep insisting the old name
// exists and you will get `undefined` at runtime instead of a compile error.
// That is the main hazard to be aware of when working in this file.
//
// A note on the optional markers (`?`) you will see throughout: a field typed
// `size_bytes?: number` may be absent from the response, so it must be
// null-checked before use. Their presence usually indicates a field the
// backend only populates in certain states.

export interface UserOut {
  id: number;
  name: string;
  email: string;
  role: string;
}

export interface BriefOut {
  id: number;
  project_id: number;
  version: number;
  content_markdown: string;
  is_approved: boolean;
}

export interface RunLogOut {
  sequence?: number;
  level?: string;
  message: string;
  created_at?: string;
}

export interface ArtifactOut {
  id?: number;
  kind: string; // "figure" | "code" | "log" | "report" | ...
  name: string;
  path?: string;
  size_bytes?: number;
  mime_type?: string;
  url?: string;
  content_base64?: string;
}

/** Resolve a URL for an artifact. Prefers explicit url/content_base64, then path. */
//
// One of the few functions here with real logic, because the backend can
// describe an artifact in four different ways and the UI needs one usable
// `src` string. The branches are ordered most-specific to most-general:
export function artifactUrl(a: ArtifactOut): string | null {
  // 1. An explicit URL — already complete, nothing to do.
  if (a.url) return a.url;

  // 2. Inline base64 content. Build a DATA URI, which embeds the bytes directly
  //    in the URL so no second network request is needed to display the image.
  if (a.content_base64) {
    // Guess the MIME type when the backend did not send one. Getting this wrong
    // means the browser refuses to render the image, so the SVG special case
    // matters — SVG is XML, and serving it as image/png silently fails.
    const mime = a.mime_type ?? (a.name.endsWith(".svg") ? "image/svg+xml" : "image/png");
    return `data:${mime};base64,${a.content_base64}`;
  }

  // 3. Nothing usable at all. Returning `null` rather than "" forces callers to
  //    handle the missing case — an empty string in an <img src> triggers a
  //    request to the current page URL, which is a classic silent bug.
  if (!a.path) return null;

  // 4. A path. It may already be absolute, in which case use it as-is.
  //    The `i` flag makes the regex case-insensitive ("HTTPS:" also matches),
  //    and `^` anchors it to the start so a path merely CONTAINING "http" is
  //    not mistaken for an absolute URL.
  if (/^https?:/i.test(a.path) || a.path.startsWith("data:")) return a.path;

  // Otherwise it is relative, so prefix the backend base. The inline
  // conditional inserts a "/" only when the path lacks one, handling both
  // "/figures/x.png" and "figures/x.png" without producing a double slash.
  const base = getApiBase();
  return `${base}${a.path.startsWith("/") ? "" : "/"}${a.path}`;
}

export interface AgenticAction {
  step?: number;
  tool?: string;
  action?: string;
  input?: unknown;
  output?: unknown;
  reason?: string;
  ts?: string;
}

export interface ExecutionResult {
  status?: string; // "ok" | "error" | ...
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  cost?: number;
  duration_ms?: number;
  results?: unknown;
}

export interface RunAnalysis {
  actions?: AgenticAction[];
  execution?: ExecutionResult;
  [k: string]: unknown;
}

export interface RunConfig {
  mode?: "real";
  orchestration?: "pipeline" | "agentic";
  advisor?: boolean;
  execute?: boolean;
  figures?: boolean;
  gpu_type?: string;
  complexity?: number;
  [k: string]: unknown;
}

// ---- Capabilities & usage -------------------------------------------------
// What this deployment can do (which providers are configured, which features
// are on) and how much the current user has spent. The UI reads these to hide
// controls that would fail, rather than letting the user click and get an error.
export interface CapabilitiesOut {
  real_run_ready: boolean;
  execute_ready: boolean;
  figures_ready: boolean;
  orchestration_modes: string[];
  gpu_types: string[];
  enabled_providers: string[];
  models: Record<string, string[]>;
  reasons?: Record<string, string>;
  [k: string]: unknown;
}
export const getCapabilities = () => request<CapabilitiesOut>("/api/capabilities");

export interface UsageOut {
  monthly_spend: number;
  monthly_limit: number;
  remaining: number;
  over_budget: boolean;
  [k: string]: unknown;
}
export const getUsage = () => request<UsageOut>("/api/me/usage");

/** Absolute URL for an artifact download endpoint. */
export function artifactDownloadUrl(artifactId: number): string {
  return `${getApiBase()}/api/artifacts/${artifactId}/download`;
}

/** Fetch an artifact as a Blob (credentials included). */
export async function fetchArtifactBlob(artifactId: number): Promise<Blob> {
  const res = await fetch(artifactDownloadUrl(artifactId), { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, `Artifact ${artifactId} failed (${res.status})`);
  return res.blob();
}

export interface RunOut {
  id: number;
  project_id: number;
  status: string; // queued | running | review | revising | completed | cancelled | failed
  mode?: "real";
  cost_estimate: number;
  budget_threshold: number;
  actual_cost: number;
  draft_markdown: string;
  session_id?: string | null;
  brief_id?: number | null;
  config_json?: RunConfig | null;
  analysis_json?: RunAnalysis | null;
  logs?: RunLogOut[];
  artifacts?: ArtifactOut[];
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}


export interface ReviewFindingOut {
  id?: number;
  run_id?: number;
  category: string;
  severity: string; // low | medium | high
  finding: string;
  suggested_fix?: string;
  status?: string;
}

export interface ProjectOut {
  id: number;
  title: string;
  objective?: string;
  status: string;
  latest_run: RunOut | null;
  review_findings: ReviewFindingOut[];
}

export interface EstimateOut {
  cost_estimate: number;
  assumptions: string | Record<string, unknown>;
}

export interface LogEvent {
  type: "log" | "status";
  status?: string;
  level?: string;
  message?: string;
  sequence?: number;
  created_at?: string;
}

export type ProviderId = "openai" | "anthropic" | "runpod" | "gemini";

export interface ProviderKeyOut {
  id: number;
  provider: ProviderId;
  model_name: string;
  is_configured: boolean;
  is_enabled: boolean;
  masked_key: string;
  key_last4: string;
  test_status: string;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
}

export interface ProviderKeyTestOut {
  provider: ProviderId;
  ok: boolean;
  status: string;
  detail: string;
  tested_at: string;
}


export interface HealthOut {
  ok: boolean;
  [k: string]: unknown;
}

// ---- Health check ---------------------------------------------------------
// Liveness probe. Note the path is `/health`, not `/api/health` — it sits
// outside the API prefix, as health checks conventionally do.
export const health = () => request<HealthOut>("/health");

// ---- Auth -----------------------------------------------------------------
// Auth is handled by Supabase (email/password + Google), independently of
// the research runner backend, so operators can sign in even when the FastAPI
// runner is offline.

// NOTE: the five functions below are the EXCEPTION in this file. Every other
// endpoint calls `request()` and hits the FastAPI backend; these call
// `supabase.auth.*` instead. The comment above explains the payoff — sign-in
// keeps working when the research runner is down, because the two systems fail
// independently.

/**
 * Convert Supabase's `User` into this app's `UserOut` shape.
 *
 * An ADAPTER: it exists so the rest of the app never has to care that
 * authentication comes from Supabase. Every consumer sees the same `UserOut`
 * whether the identity came from Supabase or (historically) the backend.
 */
function toUserOut(u: User): UserOut {
  // `user_metadata` is Supabase's free-form per-user JSON blob — anything the
  // app chose to store at sign-up. It is untyped, hence the cast and the
  // `typeof` checks below.
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  return {
    // A REAL MISMATCH, worth flagging: Supabase user IDs are UUID strings, but
    // `UserOut.id` is declared as `number`. The double cast `as unknown as
    // number` is how you force TypeScript to accept an otherwise-illegal
    // conversion — it is the compiler being overruled, not persuaded. At
    // runtime this field holds a string like "3f2a...". Anything doing
    // arithmetic or a strict `===` against a numeric id will misbehave.
    id: u.id as unknown as number,
    // A fallback chain via `||`, each step less specific than the last:
    // the stored name → the local part of the email → a generic label. The
    // `typeof meta.name === "string" && meta.name` idiom checks the type AND
    // rejects an empty string in one expression.
    name: (typeof meta.name === "string" && meta.name) || u.email?.split("@")[0] || "operator",
    email: u.email ?? "",
    // Defaults to "operator" when no role was stored. See `lib/permissions.tsx`
    // for what roles gate in the UI.
    role: (typeof meta.role === "string" && meta.role) || "operator",
  };
}

/** Sign in with email and password. Throws `ApiError(401)` on bad credentials. */
export async function login(email: string, password: string): Promise<UserOut> {
  // Supabase returns errors in the result object rather than throwing, so this
  // converts to the throwing convention every other function here follows —
  // otherwise callers would need two different error-handling styles.
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new ApiError(401, error?.message ?? "Invalid credentials");
  return toUserOut(data.user);
}

/** Create an account. Throws `ApiError(400)` if the sign-up is rejected. */
export async function register(name: string, email: string, password: string): Promise<UserOut> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // `data` here becomes the `user_metadata` that `toUserOut` reads back.
      data: { name },
      // Where the confirmation email's link lands. Built from
      // `window.location.origin` rather than hard-coded so it works across
      // local, preview, and production without configuration.
      //
      // Note this makes the function browser-only: `window` is undefined during
      // SSR, so calling `register` on the server would throw a ReferenceError.
      // Fine in practice — it only ever runs from a form submission.
      emailRedirectTo: `${window.location.origin}/console`,
    },
  });
  if (error || !data.user) throw new ApiError(400, error?.message ?? "Could not create account");
  return toUserOut(data.user);
}

/** Sign out. Always reports success. */
export async function logout(): Promise<{ ok: boolean }> {
  // Deliberately does not check for an error. If sign-out fails server-side the
  // local session is cleared regardless, and there is nothing useful for a user
  // to do about it — reporting failure here would only trap them in the UI.
  await supabase.auth.signOut();
  return { ok: true };
}

/**
 * Get the currently signed-in user, or `null` if there is none.
 *
 * Returns null rather than throwing, because "nobody is signed in" is an
 * ordinary state this app expects, not an error. That is what lets callers
 * write `const user = await me(); if (!user) redirect("/auth")`.
 */
export async function me(): Promise<UserOut | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return toUserOut(data.user);
}


// ---- Provider keys --------------------------------------------------------
// CRUD for the user's LLM provider API keys (OpenAI, Anthropic, …).
//
// Note `ProviderKeyOut` returns `masked_key` and `key_last4`, never the key
// itself: once submitted, a key is write-only. The server stores it and will
// only ever show you the last four characters, so a leaked API response cannot
// leak the credential. `testProviderKey` exists because a saved key may still
// be invalid — it makes a live call to the provider to confirm.
export const listProviderKeys = () => request<ProviderKeyOut[]>("/api/provider-keys");

export const saveProviderKey = (payload: {
  provider: ProviderId;
  api_key: string;
  model_name: string;
  is_enabled: boolean;
}) =>
  request<ProviderKeyOut>("/api/provider-keys", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const deleteProviderKey = (provider: ProviderId) =>
  request<{ ok: boolean }>(`/api/provider-keys/${provider}`, { method: "DELETE" });

export const testProviderKey = (provider: ProviderId) =>
  request<ProviderKeyTestOut>(`/api/provider-keys/${provider}/test`, { method: "POST" });


// ---- System status --------------------------------------------------------
// Live operator metrics: queue depth, throughput, spend. This is the same data
// the `system_status` MCP tool exposes to AI clients.
export interface SystemStatus {
  ok: boolean;
  region: string;
  build: string;
  ts: string;
  runs_active: number;
  runs_queued: number;
  reviewers_online: number;
  gate_latency_ms: number;
  steps_per_min: number;
  spend_per_hr: number;
}
export const getStatus = () => request<SystemStatus>("/api/status");

// ---- Projects -------------------------------------------------------------
// A PROJECT is the top-level container: one research question. The hierarchy
// used throughout this file is:
//
//   Project → Brief → Run → Campaign → Candidate
//
// Read that chain before the sections below; every later endpoint operates on
// one of those levels, and the names only make sense in relation to it.
export const listProjects = () => request<ProjectOut[]>("/api/projects");

export const getProject = (projectId: number) => request<ProjectOut>(`/api/projects/${projectId}`);

export const createProject = (payload: { title: string; objective?: string; idea_text?: string }) =>
  request<ProjectOut>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const saveIdea = (projectId: number, idea_text: string) =>
  request<ProjectOut>(`/api/projects/${projectId}/idea`, {
    method: "POST",
    body: JSON.stringify({ idea_text }),
  });

// ---- Briefs ---------------------------------------------------------------
// A BRIEF is the AI-generated research plan for a project. Note the workflow
// encoded in these three endpoints: generate → update → approve. The approval
// step is a HUMAN GATE — nothing proceeds to an expensive run until a person
// signs off. This is the first of several such gates (see G3 below).
export const generateBrief = (projectId: number) =>
  request<BriefOut>(`/api/projects/${projectId}/briefs/generate`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const updateBrief = (briefId: number, content_markdown: string) =>
  request<BriefOut>(`/api/briefs/${briefId}`, {
    method: "PATCH",
    body: JSON.stringify({ content_markdown }),
  });

export const approveBrief = (briefId: number, notes = "") =>
  request<BriefOut>(`/api/briefs/${briefId}/approve`, {
    method: "POST",
    body: JSON.stringify({ notes }),
  });

// ---- Runs -----------------------------------------------------------------
// A RUN executes an approved brief, and this is where real money is spent.
//
// Hence `estimateRun` existing separately from `startRun`: the UI shows a
// projected cost first, and `startRun` requires an explicit `approved_cost:
// true` in its payload. That flag is a deliberate speed bump — it is impossible
// to start a run without having acknowledged the estimate.
export const estimateRun = (
  projectId: number,
  payload: { budget_threshold: number; config_json?: Record<string, unknown> },
) =>
  request<EstimateOut>(`/api/projects/${projectId}/runs/estimate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const startRun = (
  projectId: number,
  payload: {
    budget_threshold: number;
    approved_cost: boolean;
    mode?: "real";
    config_json?: Record<string, unknown>;
  },
) =>
  request<RunOut>(`/api/projects/${projectId}/runs`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const listRuns = (projectId: number) => request<RunOut[]>(`/api/projects/${projectId}/runs`);

export const getRun = (runId: number) => request<RunOut>(`/api/runs/${runId}`);

export const cancelRun = (runId: number) =>
  request<RunOut>(`/api/runs/${runId}/cancel`, { method: "POST" });

// ---- Reviews / export -----------------------------------------------------
// Automated review findings, plus final approval of the output paper.
//
// `GroundednessReport` is the interesting type here: `dead_urls`,
// `placeholders`, and `fabrications` are checks for an AI-written paper citing
// sources that do not exist or leaving "TODO" text behind. `approveFinal`
// accepts `force` to override those warnings deliberately.
export const listReviews = (projectId: number) =>
  request<ReviewFindingOut[]>(`/api/projects/${projectId}/reviews`);

export interface GroundednessReport {
  score?: number;
  dead_urls?: string[];
  placeholders?: string[];
  fabrications?: string[];
  [k: string]: unknown;
}

export const approveFinal = (
  projectId: number,
  opts: { notes?: string; force?: boolean } = {},
) =>
  request<{ artifact_id?: number; markdown?: string; [k: string]: unknown }>(
    `/api/projects/${projectId}/final/approve`,
    {
      method: "POST",
      body: JSON.stringify({
        notes: opts.notes ?? "Approved from operator console.",
        force: Boolean(opts.force),
      }),
    },
  );


// ---- Targeted paper revisions (gate G3) -----------------------------------
// Request a specific edit to the generated paper instead of regenerating it.
//
// "Gate G3" is this project's name for the third human checkpoint. The flow is
// estimate → preview → apply, so an operator sees both the cost and the actual
// diff before committing — the same approve-before-spend discipline as runs.
export interface RevisionOut {
  id: number;
  run_id: number;
  status: string; // proposed | applied | rejected
  instruction: string;
  target_excerpt: string;
  replacement_markdown: string;
  cost_estimate?: number;
  actual_cost?: number;
  created_at?: string;
  applied_at?: string | null;
}

export interface RevisionEstimateOut {
  cost_estimate: number;
  assumptions?: string | Record<string, unknown>;
  [k: string]: unknown;
}

export const estimateRevision = (
  runId: number,
  payload: { instruction: string; target_excerpt: string },
) =>
  request<RevisionEstimateOut>(`/api/runs/${runId}/revisions/estimate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const previewRevision = (
  runId: number,
  payload: { instruction: string; target_excerpt: string; approved_cost?: boolean },
) =>
  request<RevisionOut>(`/api/runs/${runId}/revisions/preview`, {
    method: "POST",
    body: JSON.stringify({ approved_cost: true, ...payload }),
  });

export const listRevisions = (runId: number) =>
  request<RevisionOut[]>(`/api/runs/${runId}/revisions`);

export const applyRevision = (runId: number, revisionId: number, notes = "") =>
  request<RunOut>(`/api/runs/${runId}/revisions/${revisionId}/apply`, {
    method: "POST",
    body: JSON.stringify({ notes }),
  });

// ---- Live logs WebSocket --------------------------------------------------
//
// A genuinely different mechanism from everything above. `fetch` is
// request/response: ask once, get one answer, done. A WebSocket holds a
// persistent two-way connection so the SERVER can push data whenever it likes.
// That is what makes live-streaming run logs possible without the client
// polling every second.

/**
 * Translate an HTTP base URL into a WebSocket URL.
 *
 * WebSockets use their own schemes — `ws://` and `wss://` — which mirror
 * `http://` and `https://`. The secure pairing matters: a page served over
 * HTTPS may not open an insecure `ws://` connection, as browsers block it as
 * mixed content.
 */
function wsUrl(path: string): string {
  const base = getApiBase();
  // `replace(/^http/, "ws")` maps http→ws and https→wss in one step, since the
  // anchored `^http` prefix matches both and leaves any trailing "s" in place.
  // Neat, though it would also mangle a base URL not starting with http.
  if (base) return base.replace(/^http/, "ws") + path;
  // SSR fallback. Largely theoretical — WebSockets are a browser API — but it
  // keeps the function total rather than returning something malformed.
  if (typeof window === "undefined") return `ws://localhost:8000${path}`;
  // No configured base: connect to the origin serving the page, matching the
  // page's own security level so an HTTPS page gets `wss:`.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/** Open the run-logs socket. Returns the socket so the caller can close it. */
//
// Returning the socket is the important part of the contract: the caller MUST
// eventually call `.close()`, or the connection leaks. In React that means
// closing it from a `useEffect` cleanup — exactly the pattern shown in
// `src/hooks/use-mobile.tsx`, where an effect that opens something returns a
// function that closes it.
export function openRunLogs(runId: number, onEvent: (ev: LogEvent) => void): WebSocket {
  const ws = new WebSocket(wsUrl(`/api/runs/${runId}/logs/ws`));
  // `onEvent` is a CALLBACK — the caller supplies a function, and this invokes
  // it once per message. That inversion is what suits streaming: results arrive
  // over time rather than all at once, so there is no single value to return.
  ws.onmessage = (e) => {
    try {
      // `e.data` arrives as a raw string; the backend sends JSON per frame.
      onEvent(JSON.parse(e.data) as LogEvent);
    } catch {
      /* ignore malformed frames */
      // Deliberately swallowed. One corrupt frame should not tear down a live
      // log stream — skipping it and continuing is far better than the whole
      // console going dark. The trade-off is that a systematically malformed
      // stream fails silently with no diagnostic.
    }
  };
  // Note what is NOT handled here: `onerror`, `onclose`, and reconnection. If
  // the connection drops, the stream simply stops and the UI must notice.
  return ws;
}

// ─── Campaigns / candidates / archive (autoresearch search harness) ─────────
// Covers: Search, Memory→Archive/Ledger, Evaluation→Pareto,
// Trace Evaluation, Failure Taxonomy, Agent Evaluation, Safety→Governance.
//
// THE LARGEST SECTION IN THIS FILE, and the one behind most of the UI in
// `src/components/campaign/`. Worth understanding the domain model first,
// because the type names assume it:
//
//   A CAMPAIGN is an automated search. Rather than one run producing one
//   result, the system repeatedly proposes a change, tries it, scores it, and
//   uses what it learned to propose the next one.
//
//   A CANDIDATE is one attempt within a campaign — one proposed edit, executed
//   and scored. A campaign produces many.
//
//   An EDIT FAMILY categorises what kind of change a candidate made
//   (architecture, optimizer, data, loss, …), so results can be grouped by
//   the sort of idea that produced them.
//
// The types map onto the UI components almost one-to-one, which is the fastest
// way to build a mental model — open the component next to the type:
//
//   LeaderboardRow  → campaign/leaderboard-table.tsx   ranked candidates
//   FrontierPoint   → campaign/pareto-chart.tsx        cost/quality trade-off
//   CandidateAudit  → campaign/governance.tsx          safety checks
//   FailureKind     → campaign/failure-taxonomy.tsx    why candidates failed
//   AgentMetrics    → campaign/agent-metrics.tsx       proposer performance
//   TraceStep       → campaign/lineage-graph.tsx       what the agent did
//
// "Pareto" (in `getFrontier`) refers to the Pareto frontier: the set of
// candidates where you cannot improve one dimension — say quality — without
// giving up another, such as cost. Those are the only candidates worth
// choosing between; everything else is beaten outright on both axes.

export type CampaignStatus =
  | "queued"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "failed";

export type EditFamily =
  | "architecture"
  | "optimizer"
  | "data"
  | "loss"
  | "regularization"
  | "schedule"
  | "tooling"
  | (string & {});

export type CandidateStatus = "kept" | "discarded" | "invalid" | "running" | "queued";

export type FailureKind =
  | "syntax"
  | "import"
  | "shape"
  | "oom"
  | "nan"
  | "timeout"
  | "leakage"
  | "metric_integrity"
  | (string & {});

export interface CampaignBudget {
  max_iters?: number;
  wall_clock_minutes?: number;
  model_calls?: number;
  gpu_hours?: number;
  usd?: number;
}

export interface CampaignSpend {
  iters: number;
  wall_clock_minutes: number;
  model_calls: number;
  gpu_hours: number;
  usd: number;
}

export interface CampaignConfig {
  budget: CampaignBudget;
  max_iters?: number;
  explore?: number; // exploration rate 0..1
  edit_families?: Partial<Record<string, number>>; // family → weight
  stopping?: {
    stagnation_iters?: number;
    target_score?: number;
    max_invalid_rate?: number;
  };
  [k: string]: unknown;
}

export interface AgentMetrics {
  hit_rate: number; // improving candidates / evaluated
  invalid_rate: number;
  time_to_best_minutes: number;
  useful_regression_rate: number;
  stagnation_counter?: number;
  [k: string]: unknown;
}

export interface CampaignOut {
  id: number;
  project_id: number;
  name?: string;
  status: CampaignStatus;
  iteration: number;
  config: CampaignConfig;
  spend: CampaignSpend;
  best_score: number | null;
  best_candidate_id: number | null;
  metrics?: AgentMetrics | null;
  failure_counts?: Partial<Record<string, number>> | null;
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
}

export interface CostVector {
  usd?: number;
  gpu_hours?: number;
  model_calls?: number;
  wall_clock_minutes?: number;
  context_tokens?: number;
  [k: string]: number | undefined;
}

export interface CandidateOut {
  id: number;
  campaign_id: number;
  run_id: number | null;
  parent_id: number | null;
  iteration: number;
  edit_family: EditFamily;
  status: CandidateStatus;
  score: number | null;
  cost_vector: CostVector;
  diff?: string;
  metrics?: Record<string, number | string | null>;
  failure_kind?: FailureKind | null;
  notes?: {
    hypothesis?: string;
    result?: string;
    interpretation?: string;
  } | null;
  trace_dir?: string | null;
  audit?: CandidateAudit | null;
  created_at: string;
  ended_at?: string | null;
}

export interface CandidateAudit {
  eval_hash_match: boolean;
  leakage_scan: "clean" | "flagged" | "skipped" | (string & {});
  budget_compliant: boolean;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  decision?: "promoted" | "rejected" | "pending" | (string & {});
  reason?: string | null;
  [k: string]: unknown;
}

export interface LeaderboardRow {
  candidate_id: number;
  run_id: number | null;
  parent_id: number | null;
  edit_family: EditFamily;
  status: CandidateStatus;
  score: number | null;
  cost_usd: number | null;
  throughput?: number | null;
  context_tokens?: number | null;
  note?: string | null;
}

export interface FrontierPoint {
  candidate_id: number;
  quality: number; // e.g. accuracy or −BPB
  cost: number; // e.g. USD, GPU-hours or context tokens
  quality_label?: string;
  cost_label?: string;
  dominated: boolean;
  edit_family?: EditFamily;
}

export interface TraceStep {
  step: number;
  phase?: "inspect" | "hypothesize" | "edit" | "evaluate" | (string & {});
  tool?: string;
  prompt?: string;
  model_output?: string;
  tool_calls?: { name: string; input?: unknown; output?: unknown }[];
  parser_status?: "ok" | "repaired" | "failed" | (string & {});
  duration_ms?: number;
  tokens?: number;
  ts?: string;
}

export interface TraceFileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size_bytes?: number;
  children?: TraceFileNode[];
}

export interface CandidateTraceOut {
  candidate_id: number;
  steps: TraceStep[];
  tree?: TraceFileNode[];
  stdout?: string;
  stderr?: string;
}

export interface AuditReportOut {
  candidate_id: number;
  audit: CandidateAudit;
  checks: { name: string; ok: boolean; detail?: string }[];
  generated_at: string;
}

// ── Campaigns
export const listCampaigns = (projectId: number) =>
  request<CampaignOut[]>(`/api/projects/${projectId}/campaigns`);

export const getCampaign = (campaignId: number) =>
  request<CampaignOut>(`/api/campaigns/${campaignId}`);

export const startCampaign = (
  projectId: number,
  payload: {
    budget: CampaignBudget;
    maxIters?: number;
    editFamilies?: Record<string, number>;
    explore?: number;
    name?: string;
    stopping?: CampaignConfig["stopping"];
  },
) =>
  request<CampaignOut>(`/api/projects/${projectId}/campaigns`, {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      budget: payload.budget,
      max_iters: payload.maxIters,
      edit_families: payload.editFamilies,
      explore: payload.explore,
      stopping: payload.stopping,
    }),
  });

export const stopCampaign = (campaignId: number) =>
  request<CampaignOut>(`/api/campaigns/${campaignId}/stop`, { method: "POST" });

// ── Candidates / archive
export const listCandidates = (
  campaignId: number,
  opts: { sort?: string; filter?: string } = {},
) => {
  const q = new URLSearchParams();
  if (opts.sort) q.set("sort", opts.sort);
  if (opts.filter) q.set("filter", opts.filter);
  const qs = q.toString();
  return request<CandidateOut[]>(
    `/api/campaigns/${campaignId}/candidates${qs ? `?${qs}` : ""}`,
  );
};

export const getCandidate = (candidateId: number) =>
  request<CandidateOut>(`/api/candidates/${candidateId}`);

export const getCandidateTrace = (candidateId: number) =>
  request<CandidateTraceOut>(`/api/candidates/${candidateId}/trace`);

export const getTraceFile = (candidateId: number, path: string) =>
  request<{ path: string; content: string }>(
    `/api/candidates/${candidateId}/trace/file?path=${encodeURIComponent(path)}`,
  );

// ── Evaluation
export const getLeaderboard = (campaignId: number) =>
  request<LeaderboardRow[]>(`/api/campaigns/${campaignId}/leaderboard`);

export const getFrontier = (campaignId: number) =>
  request<FrontierPoint[]>(`/api/campaigns/${campaignId}/frontier`);

// ── Governance
export const promoteCandidate = (candidateId: number, notes = "") =>
  request<CandidateOut>(`/api/candidates/${candidateId}/promote`, {
    method: "POST",
    body: JSON.stringify({ notes }),
  });

export const rejectCandidate = (candidateId: number, reason: string) =>
  request<CandidateOut>(`/api/candidates/${candidateId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });

export const getAuditReport = (candidateId: number) =>
  request<AuditReportOut>(`/api/candidates/${candidateId}/audit`);

// ── Live search-trace stream (proposer loop events)
//
// The second of the two WebSocket streams. `openRunLogs` streams a single run's
// log lines; this streams the search loop's progress as it proposes, edits, and
// evaluates candidates. See `openRunLogs` above for the full explanation of the
// pattern — this is the same shape with a different event type.
export interface SearchTraceEvent {
  type: "search" | "status" | "log";
  // `(string & {})` is a TypeScript trick worth recognising, since it looks
  // like a mistake. A plain `"inspect" | "hypothesize" | ... | string` would
  // collapse to just `string`, destroying the autocomplete for the known
  // values. Intersecting with the empty object type prevents that collapse, so
  // you get suggestions for the four known phases WHILE still accepting any
  // other string the backend might add. "Autocomplete without a closed set."
  phase?: "inspect" | "hypothesize" | "edit" | "evaluate" | (string & {});
  campaign_id?: number;
  candidate_id?: number;
  iteration?: number;
  status?: CampaignStatus | string;
  edit_family?: EditFamily;
  score?: number;
  message?: string;
  level?: string;
  ts?: string;
}

/** Open the campaign search-trace socket. Caller owns closing it. */
export function openSearchTrace(
  campaignId: number,
  onEvent: (ev: SearchTraceEvent) => void,
): WebSocket {
  const ws = new WebSocket(wsUrl(`/api/campaigns/${campaignId}/trace/ws`));
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as SearchTraceEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  return ws;
}
