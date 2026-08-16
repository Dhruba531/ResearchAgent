// Role-based access control for the operator console.
//
// The backend user payload carries a free-form `role` string. We normalise it
// to one of the four roles below and derive a permission set from a static
// matrix. Unknown or empty roles fall back to `admin` so existing single-user
// demos keep working without a migration.
//
// ===========================================================================
// ⚠  THIS SYSTEM FAILS OPEN — READ BEFORE RELYING ON IT
// ===========================================================================
// That last sentence of the header has a significant consequence: an unknown,
// empty, or misspelled role is granted FULL ADMIN rights (see `normaliseRole`,
// which returns "admin" both for missing input and for anything unrecognised).
//
// Most access-control systems fail CLOSED — an unrecognised role gets the least
// access, so a typo or a backend change locks people out rather than letting
// them in. This one does the opposite, deliberately, so single-user demos work
// without configuring roles.
//
// It is a reasonable trade-off for a demo and a liability in multi-user
// production. Two things to keep in mind:
//
//   1. Changing the fallback to "viewer" is the one-line fix, in `normaliseRole`.
//   2. Regardless of that, this is CLIENT-SIDE ONLY. Everything here decides
//      which buttons are visible and enabled — it does not stop anyone calling
//      the API directly. UI permissions are a usability feature, not a security
//      boundary; the backend must enforce the same rules independently.
//
// This file is also the codebase's clearest example of React CONTEXT. See the
// "React glue" section below.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { UserOut } from "./api";

// The four canonical roles. A literal union, so `Record<Role, ...>` below is
// exhaustively checked — add a fifth role and every matrix in this file becomes
// a compile error until you handle it. That is the type system enforcing that
// you cannot forget one.
export type Role = "admin" | "operator" | "reviewer" | "viewer";

// Individual capabilities, namespaced `subject:verb`. Defining permissions
// separately from roles is what makes this a MATRIX rather than a hierarchy —
// note that roles here are NOT ranked. A reviewer can approve a brief and an
// operator cannot; an operator can start a run and a reviewer cannot. Neither
// outranks the other, which a simple "level 1/2/3" scheme could not express.
export type Permission =
  | "project:create"
  | "brief:edit"
  | "brief:approve"
  | "run:estimate"
  | "run:start"
  | "run:cancel"
  | "final:approve"
  | "final:force"
  | "keys:manage"
  | "review:view";

// Every permission, for the admin row below.
//
// Maintenance note: this list is written out by hand, so adding a permission to
// the union above does NOT automatically add it here. TypeScript cannot catch
// the omission, since a short array is still a valid `Permission[]`. If an
// admin mysteriously lacks a new permission, this is why.
const ALL: Permission[] = [
  "project:create",
  "brief:edit",
  "brief:approve",
  "run:estimate",
  "run:start",
  "run:cancel",
  "final:approve",
  "final:force",
  "keys:manage",
  "review:view",
];

/**
 * The permission matrix: who can do what. This is the single source of truth
 * for authorisation in the UI, which is exactly why it is worth keeping as one
 * readable table rather than scattering `if (role === "admin")` checks around.
 *
 * `Record<Role, Permission[]>` requires an entry for EVERY role — omit one and
 * it will not compile.
 *
 * Reading the design: operators DO the work (create, edit, run), reviewers
 * APPROVE it (brief:approve, final:approve), and the separation is intentional
 * — the person who ran an experiment should not be the one signing off on it.
 * Viewers get read-only access.
 */
const MATRIX: Record<Role, Permission[]> = {
  admin: ALL,
  operator: [
    "project:create",
    "brief:edit",
    "run:estimate",
    "run:start",
    "run:cancel",
    "keys:manage",
    "review:view",
  ],
  reviewer: [
    "brief:approve",
    "run:estimate",
    // Reviewers can cancel a run they consider unsound, but cannot start one.
    "run:cancel",
    "final:approve",
    // `final:force` overrides the groundedness warnings described in api.ts —
    // publishing despite detected fabrications or dead citations. Restricted to
    // reviewers and admins, appropriately.
    "final:force",
    "review:view",
  ],
  viewer: ["review:view"],
};

// Presentation lookups, kept beside the matrix so a new role is caught here too.
const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  operator: "Operator",
  reviewer: "Reviewer",
  viewer: "Viewer",
};

// Maps each role to a colour token used by the badge components. Keeping this
// mapping here rather than in the component means every badge in the app agrees
// on what colour a reviewer is.
const ROLE_TONE: Record<Role, "primary" | "info" | "warning" | "muted"> = {
  admin: "primary",
  operator: "info",
  reviewer: "warning",
  viewer: "muted",
};

/**
 * Map a free-form role string onto one of the four canonical roles.
 *
 * The aliases exist because the backend's `role` field is unconstrained and
 * different sources spell things differently — "owner", "superuser", and
 * "admin" all mean the same thing here. Normalising once at the boundary means
 * the rest of the app only ever deals with four known values.
 *
 * ⚠ BOTH fallbacks return "admin" — see the warning at the top of this file.
 */
export function normaliseRole(input: string | null | undefined): Role {
  if (!input) return "admin"; // ⚠ missing role → full access
  // Trim and lowercase first so " Admin " and "ADMIN" both match.
  const s = input.trim().toLowerCase();
  if (s === "admin" || s === "owner" || s === "superuser") return "admin";
  if (s === "operator" || s === "user" || s === "member") return "operator";
  if (s === "reviewer" || s === "approver") return "reviewer";
  if (s === "viewer" || s === "readonly" || s === "read-only" || s === "guest")
    return "viewer";
  return "admin"; // ⚠ unrecognised role → full access. Change to "viewer" to fail closed.
}

/**
 * Look up a role's permissions as a Set.
 *
 * A Set rather than the raw array because the resulting `can()` is called on
 * every render of every gated control. `set.has(x)` is O(1) where
 * `array.includes(x)` is O(n) — a small difference per call, multiplied by a
 * lot of calls.
 *
 * A NEW Set is built on each call, so callers cannot mutate the shared MATRIX.
 */
export function permissionsFor(role: Role): Set<Permission> {
  return new Set(MATRIX[role]);
}

export function roleLabel(role: Role): string {
  return ROLE_LABEL[role];
}

export function roleTone(role: Role) {
  return ROLE_TONE[role];
}

// ── React glue ────────────────────────────────────────────────────────────
//
// Everything above is plain TypeScript, testable without React. Below is the
// wiring that exposes it to components.
//
// CONTEXT solves prop drilling. The current user is needed by controls all over
// the tree; passing `user` down through every intermediate component would mean
// components that do not care about auth still having to forward it. Context
// lets a provider near the root publish a value that any descendant reads
// directly, however deep.

/** The value published to the tree. */
export interface AuthContextValue {
  user: UserOut | null;
  role: Role;
  perms: Set<Permission>;
  // `can` is included alongside `perms` as a convenience — `can("run:start")`
  // reads better at the call site than `perms.has("run:start")`.
  can: (p: Permission) => boolean;
  isReadOnly: boolean;
}

// The default value, used only when a component reads this context with no
// `AuthProvider` above it.
//
// ⚠ Note this default is also permissive: `can: () => true` grants everything.
// Consistent with the fail-open design, and the same caveat applies.
const AuthCtx = createContext<AuthContextValue>({
  user: null,
  role: "admin",
  perms: permissionsFor("admin"),
  can: () => true,
  isReadOnly: false,
});

/**
 * Wraps the app (or a subtree) and publishes the current user's permissions.
 *
 * This is a `.tsx` file rather than `.ts` precisely because of the JSX returned
 * at the end — the file extension is what allows it.
 */
export function AuthProvider({
  user,
  children,
}: {
  user: UserOut | null;
  // `ReactNode` is the type for "anything renderable" — elements, strings,
  // arrays, null. The standard type for a `children` prop.
  children: ReactNode;
}) {
  // `useMemo` here is not a micro-optimisation; it is load-bearing.
  //
  // Context triggers a re-render of every consumer whenever the provided value
  // changes IDENTITY. Building this object inline would create a new object on
  // every render of AuthProvider, so every component reading auth anywhere in
  // the tree would re-render every time — even though the permissions were
  // identical. Memoising on `[user]` means the value keeps the same identity
  // until the user actually changes.
  const value = useMemo<AuthContextValue>(() => {
    const role = normaliseRole(user?.role);
    const perms = permissionsFor(role);
    return {
      user,
      role,
      perms,
      // Closes over `perms` from this scope, so the lookup set is captured
      // rather than recomputed per call.
      can: (p) => perms.has(p),
      isReadOnly: role === "viewer",
    };
  }, [user]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/** Read the whole auth value. Use when you need the user or role themselves. */
export function useAuth(): AuthContextValue {
  return useContext(AuthCtx);
}

/**
 * Check a single permission: `const canStart = useCan("run:start")`.
 *
 * The common case, and worth having as its own hook because it states intent at
 * the call site far more clearly than destructuring `can` out of `useAuth()`.
 */
export function useCan(p: Permission): boolean {
  return useContext(AuthCtx).can(p);
}

/**
 * Human-friendly text for a disabled action explaining why the current
 * role cannot perform it. Callers use it as a `title` tooltip.
 */
//
// A genuine usability detail: a disabled button with no explanation is
// infuriating. This produces "Requires reviewer or admin. Signed in as
// Operator." — naming both what is needed and what you currently are.
export function deniedReason(role: Role, p: Permission): string {
  // `Partial<Record<...>>` makes every key optional, so this table only needs
  // entries for permissions worth explaining. Anything omitted (`review:view`,
  // `run:estimate`) falls through to the generic phrasing below.
  const need: Partial<Record<Permission, string>> = {
    "project:create": "operator or admin",
    "brief:edit": "operator or admin",
    "brief:approve": "reviewer or admin",
    "run:start": "operator or admin",
    "run:cancel": "operator, reviewer, or admin",
    "final:approve": "reviewer or admin",
    "final:force": "reviewer or admin",
    "keys:manage": "operator or admin",
  };
  // NOTE these strings are maintained by hand and can drift out of sync with
  // MATRIX above — nothing checks that they agree. If you change who can do
  // what, update both.
  const who = need[p] ?? "a higher role";
  return `Requires ${who}. Signed in as ${roleLabel(role)}.`;
}
