// Permission gating. `Gated` is the important one — it disables a control and
// explains why, rather than hiding it, because a hidden control is
// indistinguishable from a bug. Backed by the RBAC helpers in lib/permissions.

import { type ReactNode } from "react";
import { useAuth, useCan, roleLabel, deniedReason, type Permission } from "@/lib/permissions";
import { ProviderKeysPanel } from "./settings";

export function Gated({
  perm,
  disabled,
  onClick,
  className,
  title,
  children,
  type,
}: {
  perm: Permission;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
  type?: "button" | "submit" | "reset";
  children: ReactNode;
}) {
  const allowed = useCan(perm);
  const { role } = useAuth();
  return (
    <button
      // Defaults to "button" so the control cannot accidentally submit a
      // surrounding form — the same guard as in leaderboard-table.tsx.
      type={type ?? "button"}
      // BELT AND BRACES: the handler is stripped as well as the button being
      // disabled. Either alone would do, but dropping the handler means that
      // even a programmatic `.click()` cannot fire the action.
      onClick={allowed ? onClick : undefined}
      // Two independent reasons to disable: the role lacks the permission, or
      // the caller passed `disabled` for its own reasons (a request in flight).
      disabled={!allowed || disabled}
      // The tooltip explains a permission denial, otherwise defers to whatever
      // the caller supplied.
      title={!allowed ? deniedReason(role, perm) : title}
      // `|| undefined` OMITS the attribute when false rather than rendering
      // aria-disabled="false", which is the correct way to express "not
      // applicable" in ARIA.
      aria-disabled={!allowed || disabled || undefined}
      className={className}
    >
      {children}
    </button>
  );
}

/**
 * Guards the provider-keys panel at the SECTION level.
 *
 * A different strategy from `Gated`: rather than disabling controls, this
 * replaces the entire panel with an explanation. Appropriate here because API
 * keys are sensitive — showing a viewer the shape of the settings, greyed out,
 * would leak more than it helps.
 *
 * The rule of thumb: disable individual ACTIONS, replace whole SECTIONS.
 */
export function ProviderKeysGate() {
  const canManage = useCan("keys:manage");
  const { role } = useAuth();
  if (!canManage) {
    return (
      <div className="panel p-5">
        <div className="mono-label">provider keys</div>
        <p className="mt-2 font-mono text-[12px] text-muted-foreground">
          Provider key management is restricted to privileged roles. Signed in as{" "}
          <span className="text-foreground">{roleLabel(role)}</span>.
        </p>
      </div>
    );
  }
  return <ProviderKeysPanel />;
}

/**
 * A one-line banner shown to viewers explaining why nothing is clickable.
 *
 * Without it, a read-only user sees a console full of disabled buttons and
 * reasonably concludes the app is broken. Stating the reason once at the top is
 * far better than making them hover each control for a tooltip.
 */
export function RoleBanner() {
  const { role, isReadOnly } = useAuth();
  // Renders nothing for anyone who is not read-only.
  if (!isReadOnly) return null;
  return (
    <div className="mt-8 rounded-md border border-panel-border bg-panel/60 px-4 py-3 font-mono text-[12px] text-muted-foreground">
      <span className="mr-2 inline-flex items-center gap-1.5 rounded-full border border-panel-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-foreground">
        {roleLabel(role)}
      </span>
      Read-only session. You can browse projects, runs, and review findings, but action buttons are
      disabled.
    </div>
  );
}

// ─── Navigation & chrome ───────────────────────────────────────────────────

// The sidebar links. These are ANCHOR hrefs (#workspace), not routes — the
// console is a single long page, so navigation scrolls within it rather than
// changing the URL path. That is why `Section` in index.tsx needs `scroll-mt`.
