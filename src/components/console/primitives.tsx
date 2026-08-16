// Small presentational building blocks shared across the console surfaces.
// The console's local equivalent of `campaign/primitives.tsx`.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { useCan, deniedReason } from "@/lib/permissions";

export type DotTone = "success" | "warning" | "error" | "muted" | "info";

// ─── UI atoms ──────────────────────────────────────────────────────────────
// Small presentational pieces, the local counterpart of campaign/primitives.tsx.
// Each is a few lines; skim them and move on.

/** A small coloured status dot. */
// The `pulse` prop is declared but never used in the body — dead API surface,
// harmless but safe to remove.
export function Dot({ tone = "success" }: { tone?: DotTone; pulse?: boolean }) {
  const map: Record<DotTone, string> = {
    success: "bg-primary",
    warning: "bg-warning",
    error: "bg-destructive",
    info: "bg-accent",
    muted: "bg-muted-foreground",
  };
  return <span className={`block h-2 w-2 rounded-full ${map[tone]}`} />;
}

/** A small icon-plus-label heading used at the top of each panel. */
export function SectionHeader({
  icon,
  children,
  right,
}: {
  icon: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-panel-border px-5 py-3 font-mono text-[11px] tracking-[0.15em] text-muted-foreground">
      <span className="flex items-center gap-2">
        <span className="text-foreground">{icon}</span> {children}
      </span>
      {right}
    </div>
  );
}

/** A large single-metric card used across the pipeline summary. */
export function StateCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="relative min-w-0 px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-primary/70" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-2 truncate font-serif text-[26px] leading-[1.1] tracking-tight text-foreground">
        {value}
      </div>
      <div className="mono-label mt-1.5 truncate">{caption}</div>
    </div>
  );
}

/** Renders a run status as a dot plus an upper-case label. */
export function StatusBadge({ status }: { status: string }) {
  // Normalised before matching so casing or a null from the backend cannot
  // silently fall through to the "muted" default.
  const s = (status || "").toLowerCase();
  // A ternary chain rather than the lookup-object approach used by
  // `campaign/primitives.tsx` — several statuses map to the same tone, so a
  // full table would repeat itself. Both are reasonable; be aware the codebase
  // uses each in different places.
  const tone: DotTone =
    s === "running" || s === "active"
      ? "success"
      : s === "queued" || s === "briefing" || s === "review" || s === "revising"
        ? "warning"
        : s === "failed" || s === "cancelled"
          ? "error"
          : s === "completed"
            ? "success"
            : "muted";
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">
      <Dot tone={tone} /> {(status || "draft").toUpperCase()}
    </span>
  );
}

/**
 * A large clickable tile that behaves as an on/off switch.
 *
 * `role="switch"` with `aria-checked` is what makes this announce correctly to
 * screen readers — without them it is just a button, and its state is invisible
 * to assistive technology. Using a real <button> also gives keyboard operation
 * for free.
 */
export function ToggleTile({
  on,
  onChange,
  icon,
  label,
  caption,
  tone = "primary",
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  icon: string;
  label: string;
  caption: string;
  tone?: "primary" | "danger";
}) {
  const activeBorder = tone === "danger" ? "border-destructive/60" : "border-primary/60";
  const activeBg = tone === "danger" ? "bg-destructive/10" : "bg-primary/10";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        on
          ? `${activeBorder} ${activeBg} text-foreground`
          : "border-panel-border bg-background/40 text-muted-foreground hover:text-foreground"
      }`}
    >
      <span className="mt-0.5 text-base leading-none">{icon}</span>
      <span className="flex-1">
        <span className="block font-mono text-xs">{label}</span>
        <span className="block font-mono text-[10px] text-muted-foreground">{caption}</span>
      </span>
      <span
        className={`mt-1 inline-block h-2 w-2 rounded-full ${
          on ? (tone === "danger" ? "bg-destructive" : "bg-primary") : "bg-muted-foreground/40"
        }`}
      />
    </button>
  );
}

/**
 * Extract a displayable message from an unknown thrown value.
 *
 * Used by nearly every catch block in this file. It exists because JavaScript
 * permits throwing anything, so `e.message` is not safe to read directly.
 *
 * The `ApiError` branch is first for intent rather than necessity — `ApiError`
 * extends `Error`, so the second branch would catch it anyway, but checking it
 * explicitly documents that API failures are the expected case and leaves an
 * obvious place to add status-specific handling later.
 */
export function friendlyError(e: unknown, fallback = "Request failed"): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}

// ─── Shell (nav + project rail) ────────────────────────────────────────────

/** The AgentLab wordmark, linking back to the landing page. */
export function Logomark() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg font-mono text-[12px] text-white"
        style={{ background: "var(--gradient-signal)" }}
      >
        [/]
      </span>
      <span className="font-serif text-[19px] leading-none text-foreground">AgentLab</span>
    </Link>
  );
}

// ─── RBAC UI helpers ───────────────────────────────────────────────────────
// The UI half of the role system defined in `src/lib/permissions.tsx`. Read
// that file first — it defines the roles, the permission matrix, and the
// `useCan` hook these components consume.
//
// ⚠ Remember the caveat from that file: this is CLIENT-SIDE gating only. It
// governs which buttons are usable, not what the API will accept. The backend
// must enforce the same rules independently.

/**
 * Wraps a button so it renders disabled with a tooltip when the current role
 * lacks the required permission. Children compose as normal button content.
 *
 * THE MOST IMPORTANT COMPONENT IN THIS SECTION — it appears throughout the
 * file wherever an action is permission-controlled.
 *
 * The design decision worth noting: it DISABLES rather than HIDES. A hidden
 * button is indistinguishable from a missing feature or a bug, whereas a
 * disabled one with an explanatory tooltip tells the user the action exists and
 * what they would need in order to use it. `deniedReason` supplies that text.
 */

export function BentoHead({
  kicker,
  title,
  subtitle,
  meta,
}: {
  kicker: string;
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-panel-border px-6 py-5">
      <div className="min-w-0">
        <div className="mono-label">{kicker}</div>
        <h3 className="mt-1.5 font-serif text-2xl leading-[1.1] tracking-tight text-foreground">
          {title}
        </h3>
        {subtitle && (
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {meta && <div className="flex shrink-0 items-center gap-2">{meta}</div>}
    </div>
  );
}

/** A pill with a status dot. Local twin of `Chip` in campaign/primitives.tsx. */
export function MetaChip({
  tone = "muted",
  children,
}: {
  tone?: DotTone;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-panel-border bg-background/50 px-3 py-1 font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground">
      <Dot tone={tone} pulse={tone === "success" || tone === "warning"} />
      {children}
    </span>
  );
}

/**
 * A labelled metric tile.
 *
 * Note this is character-for-character the same component as `Stat` in
 * `components/campaign/primitives.tsx` — a clear duplication, and one of the
 * easier wins if this file is ever split up: import the shared one instead.
 */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-panel-border bg-background/40 p-3">
      <div className="mono-label">{label}</div>
      <div className="mt-1.5 font-mono text-[15px] text-foreground">{value}</div>
      {hint && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

// ─── Live logs ─────────────────────────────────────────────────────────────
// The execution phase: what the agent is doing right now.

/**
 * The streaming log viewer.
 *
 * Purely presentational — the WebSocket lives in `ConsolePage`, which passes
 * the accumulated `events` down. Keeping the socket in the parent means the log
 * survives this component unmounting (when a panel is collapsed, say) and only
 * one connection is ever open.
 */
