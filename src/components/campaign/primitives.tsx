// Shared presentation primitives for the search-harness surfaces. Mirrors the
// console's panel / BentoHead / StatTile language so campaigns feel native.
//
// ===========================================================================
// READ THIS FILE FIRST — every other file in `campaign/` imports from it
// ===========================================================================
// These are small, presentational building blocks. Learning the eight of them
// makes the rest of the folder easy, because the feature components are mostly
// arrangements of these plus data.
//
// "Presentational" means they take props and return markup: no data fetching,
// no state, no side effects. That makes them trivial to reason about — the same
// props always produce the same output.
//
// A note on the Tailwind class names, since they are not stock Tailwind:
// `bg-success`, `text-muted-foreground`, and `border-panel-border` are DESIGN
// TOKENS defined in `src/styles.css`. The indirection is what makes theming
// work — `bg-success` resolves to a different colour under `.theme-console`
// (see `components/workspace-theme.tsx`) without any component changing.
// Prefer a token over a literal colour like `bg-green-500`.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { CandidateStatus } from "@/lib/api";

// The semantic colour vocabulary used across this folder. Naming by MEANING
// rather than by colour is deliberate: a component asks for "danger", not
// "red", so the palette can change centrally.
export type Tone = "success" | "warning" | "danger" | "muted" | "info";

/** A small status dot. The most-reused primitive here — see `Chip` below. */
export function Dot({ tone = "muted" }: { tone?: Tone }) {
  // A lookup object rather than a chain of ternaries. `Record<Tone, string>`
  // forces an entry for every tone, so adding a tone to the union above turns
  // this into a compile error until it is handled — the same exhaustiveness
  // trick used by the permission matrices in `lib/permissions.tsx`.
  //
  // Why the map cannot be built dynamically: Tailwind scans source files for
  // complete class strings at build time. `bg-${tone}` would produce a class
  // that never appears literally in the source, so the CSS would not be
  // generated and the colour would silently be missing. Every Tailwind class
  // must appear in full somewhere.
  const map: Record<Tone, string> = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-primary",
    muted: "bg-muted-foreground/50", // `/50` is opacity — 50% of the token colour
  };
  // h-1.5/w-1.5 = 6px square; `rounded-full` turns the square into a circle.
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full", map[tone])} />;
}

/**
 * The standard bordered container. Nearly every surface in `campaign/` is
 * wrapped in one.
 *
 * Note the `className` prop merged through `cn` — this is the overridable-style
 * pattern described in `lib/utils.ts`. It lets a caller pass `className="mt-8"`
 * to adjust spacing without this component knowing about every context it
 * appears in.
 *
 * `overflow-hidden` makes child corners respect the panel's rounded border; a
 * table or image inside would otherwise square them off.
 */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  // `<section>` rather than `<div>` — a semantic landmark for screen readers.
  return <section className={cn("panel overflow-hidden", className)}>{children}</section>;
}

/**
 * The header bar for a `Panel`: an all-caps kicker, a serif title, an optional
 * subtitle, and an optional slot for controls on the right.
 */
export function PanelHead({
  kicker,
  title,
  subtitle,
  meta,
}: {
  kicker: string;
  title: string;
  subtitle?: string;
  // `meta` is typed `ReactNode`, not `string` — so callers pass JSX (buttons,
  // chips), not just text. Accepting an element as a prop like this is the
  // "slot" pattern: the parent decides what goes there, this component only
  // decides where it sits.
  meta?: ReactNode;
}) {
  return (
    // `items-end` aligns the two groups along their baselines; `flex-wrap` lets
    // `meta` drop to its own line on narrow screens rather than overflowing.
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-panel-border px-6 py-5">
      {/* `min-w-0` looks pointless but is essential. A flex child defaults to
          min-width:auto, meaning it refuses to shrink below its content — long
          titles then overflow the panel instead of wrapping. This is the single
          most common flexbox overflow bug. */}
      <div className="min-w-0">
        <div className="mono-label">{kicker}</div>
        <h3 className="mt-1.5 font-serif text-xl leading-[1.15] tracking-tight text-foreground">
          {title}
        </h3>
        {/* `{cond && <jsx/>}` is React's conditional render idiom: when `cond`
            is falsy the expression yields it and React renders nothing. Works
            because React ignores false/null/undefined children.

            One gotcha to know: this is only safe with a BOOLEAN-ish condition.
            `{items.length && <List/>}` renders a literal "0" when the array is
            empty, because 0 is falsy but still a valid React child. */}
        {subtitle && (
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {/* `shrink-0` stops the controls being squashed when the title is long —
          the title side has `min-w-0` and absorbs the shrinking instead. */}
      {meta && <div className="flex shrink-0 items-center gap-2">{meta}</div>}
    </div>
  );
}

/** A pill-shaped label with a status dot. Composes `Dot`. */
export function Chip({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-panel-border bg-background/50 px-3 py-1 font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">
      {/* Composition in action: Chip does not reimplement the dot, it uses one
          and forwards the tone. */}
      <Dot tone={tone} />
      {children}
    </span>
  );
}

/** A labelled metric box: label on top, value below, optional hint under that. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  // `ReactNode` rather than `string`, so a caller can pass formatted JSX — a
  // number with a coloured delta beside it, for instance.
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-panel-border bg-background/40 p-3">
      <div className="mono-label">{label}</div>
      {/* Monospace for numbers is a deliberate choice: digits share a fixed
          width, so values in a column line up and do not jitter as they change
          during live polling. */}
      <div className="mt-1.5 font-mono text-[15px] text-foreground">{value}</div>
      {hint && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Placeholder shown when a list or table has nothing to display. */
//
// Worth having as a shared primitive: an empty table with no explanation reads
// as a bug. A consistent empty state tells the user the request succeeded and
// there is simply nothing yet.
export function EmptyState({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-mono text-[12px] text-muted-foreground">{label}</p>
      {hint && <p className="mt-1 text-[12px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

/**
 * Maps a backend status string to a semantic tone.
 *
 * Typed `Record<string, Tone>` rather than `Record<CandidateStatus, Tone>`
 * because it covers BOTH candidate statuses (kept, discarded, invalid…) and
 * campaign statuses (completed, failed, stopped…). The looser key type is the
 * price of that reuse — it means a typo'd key will not be caught here, which is
 * why `StatusPill` below defends with `?? "muted"`.
 */
export const statusTone: Record<string, Tone> = {
  kept: "success",
  running: "info",
  queued: "muted",
  discarded: "warning", // expected outcome of a search, not an error
  invalid: "danger", // the candidate was broken, which is a real problem
  completed: "success",
  failed: "danger",
  stopped: "muted",
  paused: "warning",
};

/** Renders a status string as a coloured, outlined pill. */
export function StatusPill({ status }: { status: CandidateStatus | string }) {
  // `?? "muted"` is the safety net for the loose typing noted above: an
  // unrecognised status renders in a neutral tone rather than crashing on an
  // undefined class lookup.
  const tone = statusTone[status] ?? "muted";
  // Outlined rather than filled — see `Dot` for why this map is written out in
  // full instead of composed from a template string.
  const cls: Record<Tone, string> = {
    success: "border-success/40 text-success",
    warning: "border-warning/40 text-warning",
    danger: "border-destructive/40 text-destructive",
    info: "border-primary/40 text-primary",
    muted: "border-panel-border text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]",
        cls[tone],
      )}
    >
      {status}
    </span>
  );
}

/**
 * Format a number to fixed decimal places, or an em dash when absent.
 *
 * The em dash matters: rendering "null" or "NaN" in a metrics table looks like
 * a crash, whereas "—" reads as "no value", which is usually the truth.
 */
export function fmtNum(n: number | null | undefined, digits = 3): string {
  // `n == null` with LOOSE equality is intentional and idiomatic — it is true
  // for both `null` and `undefined` and nothing else, so it covers both in one
  // check. This is the one place `==` is preferred over `===`.
  //
  // The `Number.isNaN` check is separate because NaN is a number by type but
  // meaningless as a value, and `NaN.toFixed(3)` yields the string "NaN".
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

/** Format a number as USD. Note it does NOT guard against NaN — see `fmtNum`. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Number(n).toFixed(2)}`;
}

/**
 * Chart colours, as CSS variable references rather than literal values.
 *
 * This is what lets Recharts follow the theme. Recharts needs colours as
 * strings in JavaScript, but hard-coding "#22c55e" would freeze the palette and
 * break under a different theme. `var(--success)` is resolved by the BROWSER at
 * paint time, so the chart re-colours automatically when the theme class
 * changes — the same mechanism the Tailwind tokens use.
 */
export const CHART_COLORS = {
  primary: "var(--primary)",
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
  grid: "var(--border)",
  muted: "var(--muted-foreground)",
};
