// The public landing page (/). The largest route after console.tsx at ~660
// lines, but MUCH easier: it is almost entirely presentational markup, split
// into one component per page section.
//
// STRUCTURE — read it in this order:
//   1. The layout system (SHELL, GRID, Shell, Section, SectionHead) — the
//      shared rails every section aligns to. The block comment below explains
//      the grid; understand that and the rest falls into place.
//   2. Small presentational primitives (StatusDot, Eyebrow, Chip, Card) —
//      a local echo of `components/campaign/primitives.tsx`.
//   3. Page sections (Hero, Workflow, Controls, LiveTelemetry, CTA, Footer),
//      assembled by `Landing` at the very bottom.
//
// Only ONE part of this file does anything dynamic: `LiveTelemetry`, which
// polls the backend every 5 seconds. Everything else is static. If you are
// skimming, read the layout system and `LiveTelemetry` and skip the rest.

import { createFileRoute, Link } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { useEffect, useState } from "react";

import { getStatus, type SystemStatus } from "@/lib/api";

export const Route = createFileRoute("/")({
  component: Landing,
});

/* ---------------------------------------------------------------------------
 * Layout system
 *
 * One container width, one gutter, one 12-column grid. Every section, card,
 * rail and the command bar hang off the same rails:
 *   cols 1–6   → primary column (headline, hero copy, lead card)
 *   cols 7–12  → secondary column (panel, supporting copy, card row)
 * Card padding is always p-6; section rhythm is always py-20 / lg:py-28.
 * ------------------------------------------------------------------------ */

// Two class strings shared by every section. Extracting them into constants is
// what actually enforces the "one container width, one gutter" rule described
// above — the alternative is retyping the same six classes in a dozen places
// and having one of them silently drift.
const SHELL = "mx-auto w-full max-w-[1400px] px-6 lg:px-10";
// A 12-column grid, the standard editorial layout unit. Sections then claim
// spans of it (`col-span-6`, `col-span-12`) so everything lines up vertically
// down the page.
const GRID = "grid grid-cols-12 gap-x-6 gap-y-6";

function Shell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`${SHELL} ${className}`}>{children}</div>;
}

/**
 * One page section: consistent vertical rhythm, optional top rule.
 *
 * `rule = true` by default, so sections are separated by a hairline unless a
 * caller opts out — the right default, since most sections want one.
 */
function Section({
  id,
  children,
  rule = true,
}: {
  id?: string;
  children: React.ReactNode;
  rule?: boolean;
}) {
  return (
    // `scroll-mt-16` sets scroll-margin-top: when an in-page anchor (#telemetry)
    // scrolls this section into view, the browser stops 4rem short so the
    // sticky header does not cover the heading. A small detail that is very
    // noticeable when missing.
    <section id={id} className="scroll-mt-16">
      <Shell>
        <div className={`${rule ? "border-t border-panel-border" : ""} py-20 lg:py-28`}>
          {children}
        </div>
      </Shell>
    </section>
  );
}

/** Section header locked to the same rails in every section. */
function SectionHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <header className={`${GRID} items-start`}>
      <div className="col-span-12">
        <Eyebrow>{eyebrow}</Eyebrow>
      </div>
      <h2
        className="col-span-12 font-serif leading-[1.05] tracking-[-0.02em] text-foreground lg:col-span-6"
        style={{ fontSize: "clamp(1.9rem, 3.2vw, 2.9rem)" }}
      >
        {title}
      </h2>
      {lede && (
        <p className="col-span-12 text-[15px] leading-[1.65] text-muted-foreground lg:col-span-5 lg:col-start-8">
          {lede}
        </p>
      )}
    </header>
  );
}

/* ---------- primitives ---------- */

type Tone = "success" | "warning" | "error" | "muted" | "info";

function StatusDot({ tone = "success", size = "sm" }: { tone?: Tone; size?: "sm" | "md" }) {
  const s = size === "md" ? "h-2.5 w-2.5" : "h-2 w-2";
  if (tone === "success") return <span className={`block shrink-0 rounded-full bg-primary ${s}`} />;
  if (tone === "warning") return <span className={`block shrink-0 rounded-full bg-warning ${s}`} />;
  if (tone === "error")
    return <span className={`block shrink-0 rounded-full bg-destructive ${s}`} />;
  if (tone === "info")
    return (
      <span
        className={`block shrink-0 rounded-full ${s}`}
        style={{ background: "oklch(0.72 0.12 240)" }}
      />
    );
  return <span className={`block shrink-0 rounded-full bg-muted-foreground/70 ${s}`} />;
}

/** Small uppercase label. Same height everywhere so grid rows stay flush. */
function Eyebrow({ children, tone = "success" }: { children: React.ReactNode; tone?: Tone }) {
  return (
    <span className="mb-4 flex h-5 items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

function Chip({ children, tone = "success" }: { children: React.ReactNode; tone?: Tone }) {
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-full border border-panel-border bg-panel px-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

/** Card: identical padding + header slot so every card's content starts on the same line. */
function Card({
  label,
  children,
  className = "",
  aside,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
  aside?: React.ReactNode;
}) {
  return (
    <article className={`panel flex flex-col overflow-hidden p-6 ${className}`}>
      {label && (
        <div className="mb-4 flex h-5 items-center justify-between gap-3">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            {label}
          </span>
          {aside}
        </div>
      )}
      {children}
    </article>
  );
}

function Logomark() {
  return (
    <span className="flex shrink-0 items-baseline gap-2">
      <span className="font-mono text-[13px] leading-none text-primary">[/]</span>
      <span className="font-serif text-[21px] leading-none text-foreground">AgentLab</span>
    </span>
  );
}

/* ---------- command bar ---------- */

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background">
      <Shell>
        <div className={`${GRID} h-16 items-center gap-y-0`}>
          <div className="col-span-6 flex min-w-0 items-center gap-4 lg:col-span-4">
            <Logomark />
            <span className="hidden min-w-0 items-center gap-2 rounded-full border border-panel-border bg-panel/60 px-3 py-1 font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground 2xl:inline-flex">
              <StatusDot /> <span className="truncate">agentlab.local · mvp-2026.04</span>
            </span>
          </div>
          <nav className="col-span-4 hidden items-center justify-center gap-9 text-sm text-muted-foreground lg:flex">
            <a href="#workflow" className="hover:text-foreground">
              Workflow
            </a>
            <a href="#controls" className="hover:text-foreground">
              Controls
            </a>
            <a href="#telemetry" className="hover:text-foreground">
              Telemetry
            </a>
            <Link to="/changelog" className="hover:text-foreground">
              Changelog
            </Link>
          </nav>
          <div className="col-span-6 flex items-center justify-end gap-3 lg:col-span-4">
            <Link
              to="/auth"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              Sign in
            </Link>
            <Link
              to="/console"
              search={{ tl: undefined }}
              className="shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-95"
            >
              Open console
            </Link>
          </div>
        </div>
      </Shell>
    </header>
  );
}

/* ---------- hero ---------- */

function HeroCopy() {
  return (
    <div className="col-span-12 min-w-0 lg:col-span-6">
      <Eyebrow>build 2026.04 · self-hosted</Eyebrow>

      <h1
        className="font-serif font-normal leading-[1.03] tracking-[-0.025em] text-foreground"
        style={{ fontSize: "clamp(2.4rem, 4.6vw, 4.25rem)" }}
      >
        A console for running research agents you still have to sign off on.
      </h1>

      <p className="mt-7 max-w-[46ch] text-[15.5px] leading-[1.65] text-muted-foreground">
        AgentLab wraps a FastAPI agent runner in a workflow: write a brief, estimate the cost, run
        it, then approve the output before anything leaves the machine. Runs stream over a
        WebSocket; artifacts stay on disk.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          to="/auth"
          className="inline-flex h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-95"
        >
          Sign in
        </Link>
        <a
          href="#workflow"
          className="inline-flex h-11 items-center rounded-md border border-panel-border bg-panel/60 px-5 text-sm text-foreground hover:border-foreground/40"
        >
          How a run works
        </a>
      </div>

      <dl className="mt-10 divide-y divide-panel-border border-y border-panel-border font-mono text-xs">
        {[
          ["stack", "TanStack Start · FastAPI · SQLite"],
          ["runner", "real providers · human-gated"],
          ["gates", "brief · budget · final export"],
        ].map(([k, v]) => (
          <div key={k} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-4 py-3">
            <dt className="uppercase tracking-[0.14em] text-muted-foreground">{k}</dt>
            <dd className="text-foreground/85">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RunPanel() {
  const logs: Array<[string, string, string]> = [
    ["00:00.142", "query", "arxiv: 'session management' (14 papers)"],
    ["00:00.318", "read", "synthesising abstracts · key findings"],
    ["00:00.902", "cross", "github: 6 repos · similar auth patterns"],
    ["00:01.044", "source", "owasp cheat-sheet v2 (2024) · pulling"],
    ["00:01.337", "analyse", "risk matrix: 3 high · 7 medium · 2 low"],
    ["00:02.001", "draft", "research note: auth-session.md (+412)"],
    ["00:02.488", "cite", "formatted 23 citations · apa style"],
  ];

  return (
    <div className="col-span-12 lg:col-span-6 lg:col-start-7">
      {/* spacer matches the hero eyebrow row so the panel top aligns with the H1 */}
      <div aria-hidden className="mb-4 hidden h-5 lg:block" />
      <div className="panel p-6">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-panel-border pb-4">
          <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] tracking-[0.14em] text-muted-foreground">
            <StatusDot /> RESEARCH ·{" "}
            <span className="truncate text-foreground">AUTH-SESSION-DEEP-DIVE</span>
          </div>
          <div className="flex shrink-0 items-center gap-4 font-mono text-[11px] text-muted-foreground">
            <span>
              sources <span className="text-foreground">38 / 50</span>
            </span>
            <span className="text-foreground">$0.38</span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3">
          {[
            { k: "G1 QUERY", v: "passed", tone: "success" as const },
            { k: "G2 SYNTHESIS", v: "awaiting review", tone: "warning" as const },
            { k: "G3 EXPORT", v: "queued", tone: "muted" as const },
          ].map((g) => (
            <div key={g.k} className="rounded-md border border-panel-border bg-background/40 p-3">
              <div className="flex h-4 items-center gap-2 font-mono text-[10px] tracking-[0.14em] text-muted-foreground">
                <StatusDot tone={g.tone} /> <span className="truncate">{g.k}</span>
              </div>
              <div className="mt-1.5 truncate font-mono text-xs text-foreground">{g.v}</div>
            </div>
          ))}
        </div>

        <div className="mt-5 space-y-1.5 font-mono text-[12px] leading-relaxed">
          {logs.map(([t, k, m]) => (
            <div key={t} className="grid grid-cols-[5rem_4rem_minmax(0,1fr)] gap-3">
              <span className="text-muted-foreground">{t}</span>
              <span className="text-primary/85">{k}</span>
              <span className="truncate text-foreground/90">{m}</span>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-panel-border pt-4">
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            waiting on reviewer · 2 gates remaining
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button className="h-8 rounded-md border border-panel-border px-3 text-xs text-muted-foreground hover:text-foreground">
              Reject
            </button>
            <button className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground">
              Approve G2
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(oklch(0.94 0.005 180) 1px, transparent 1px), linear-gradient(90deg, oklch(0.94 0.005 180) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 80% 60% at 50% 20%, black, transparent 75%)",
        }}
      />
      <Shell className="relative">
        <div className={`${GRID} items-start py-16 lg:gap-y-10 lg:py-24`}>
          <HeroCopy />
          <RunPanel />
        </div>
      </Shell>
    </section>
  );
}

/* ---------- workflow ---------- */

function Workflow() {
  const steps = [
    {
      n: "01",
      k: "Brief",
      t: "Draft the research brief",
      d: "Capture the question, constraints, budget, and success criteria before any agent runs.",
    },
    {
      n: "02",
      k: "Plan",
      t: "Agents propose a plan",
      d: "Multi-step plan with sources, tools, and per-step cost estimates — approved before execution.",
    },
    {
      n: "03",
      k: "Run",
      t: "Execute under gates",
      d: "Live logs, artifacts, and cost meter. Pause on risky tool calls or budget overruns.",
    },
    {
      n: "04",
      k: "Export",
      t: "Sign, cite, deliver",
      d: "Groundedness check, human sign-off, and a signed bundle of every artifact.",
    },
  ];

  return (
    <Section id="workflow" rule={false}>
      <SectionHead
        eyebrow="the workflow"
        title="Four steps, three places a human has to say yes."
        lede="Projects always move in the same order. Nothing skips ahead: a run can't start before the brief is approved, and the export stays locked until someone signs it off."
      />

      <ol className={`${GRID} mt-12`}>
        {steps.map((s) => (
          <li key={s.n} className="col-span-12 sm:col-span-6 xl:col-span-3">
            <Card
              label={`step · ${s.n}`}
              aside={
                <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-primary/80">
                  {s.k}
                </span>
              }
              className="h-full transition-colors hover:border-foreground/30"
            >
              <h3 className="font-serif text-[26px] leading-tight text-foreground">{s.t}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              <div aria-hidden className="mt-auto pt-6">
                <div className="h-px w-10 bg-panel-border" />
              </div>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ---------- controls ---------- */

function Controls() {
  return (
    <Section id="controls">
      <SectionHead
        eyebrow="operator controls"
        title="What the operator actually gets to control."
        lede="Tool-level gates, a hard spend ceiling, and the artifact bundle that comes out at the end."
      />

      <div className={`${GRID} mt-12`}>
        {/* Approval gates — cols 1–6 */}
        <Card label="approval gates" className="col-span-12 lg:col-span-6 lg:row-span-2">
          <h3 className="font-serif text-[30px] leading-tight text-foreground">
            Decide per tool what needs a human.
          </h3>
          <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
            Shell execution and outbound writes are gated by default; local writes run through.
            Anything gated shows up in the reviewer panel with the arguments it was called with.
          </p>

          <div className="mt-auto space-y-2 pt-8">
            {(
              [
                ["shell.exec", "gated", "warning"],
                ["http.post external", "gated", "warning"],
                ["fs.write /out", "auto", "success"],
                ["export.final", "review", "warning"],
              ] as const
            ).map(([tool, state, tone]) => (
              <div
                key={tool}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-md border border-panel-border bg-background/40 px-3 py-2 font-mono text-xs"
              >
                <span className="truncate text-foreground">{tool}</span>
                <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                  <StatusDot tone={tone} /> {state}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* Budget — cols 7–10 */}
        <Card label="budget ceiling" className="col-span-12 sm:col-span-8 lg:col-span-4">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-4xl leading-none text-foreground">$8.20</span>
            <span className="font-mono text-xs text-muted-foreground">/ $12.00</span>
          </div>
          <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-panel-border/60">
            <div className="h-full rounded-full bg-primary" style={{ width: "68%" }} />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Runs auto-pause at the ceiling. Reviewers can extend, downgrade models, or terminate.
          </p>
        </Card>

        {/* Roles — cols 11–12 */}
        <Card label="roles" className="col-span-12 sm:col-span-4 lg:col-span-2">
          <ul className="space-y-1.5 font-mono text-[11px] text-muted-foreground">
            <li className="text-foreground">admin</li>
            <li>operator</li>
            <li>reviewer</li>
            <li>viewer</li>
          </ul>
        </Card>

        {/* Artifacts — cols 7–12 */}
        <Card label="artifact bundle" className="col-span-12 lg:col-span-6">
          <h3 className="font-serif text-xl leading-tight text-foreground">
            Everything the run wrote, in one download.
          </h3>
          <div className="mt-4 grid gap-1.5 font-mono text-[11px] text-muted-foreground sm:grid-cols-2">
            <div>auth-session.md · 12 KB</div>
            <div>risk-matrix.csv · 3 KB</div>
            <div>citations.bib · 6 KB</div>
            <div>run.sig · ed25519</div>
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* ---------- telemetry ---------- */

/**
 * The only dynamic section on this page: live backend metrics, polled every
 * five seconds.
 *
 * Hand-rolled with `useEffect` + `setInterval` rather than TanStack Query,
 * because this is the public landing page and pulls in no query provider. The
 * effect below is a good study in the two things manual polling must get right:
 * cancelling the interval, and ignoring results that arrive after unmount.
 */
function LiveTelemetry() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    // THE `alive` FLAG — the classic guard against setting state on an
    // unmounted component. A request in flight when the user navigates away
    // still resolves, and calling `setData` then would be a wasted render at
    // best. Flipping this in the cleanup makes every late callback a no-op.
    let alive = true;
    const tick = () =>
      getStatus()
        // `alive && (setData(s), setErr(false))` — the COMMA OPERATOR evaluates
        // both calls and yields the last value, letting two statements sit in
        // one expression. Compact, though a braced arrow body would read more
        // plainly.
        .then((s) => alive && (setData(s), setErr(false)))
        .catch(() => alive && setErr(true));
    // Fire immediately, THEN start the interval. Without this call the panel
    // would sit empty for the first five seconds — `setInterval` waits a full
    // period before its first tick.
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      // Clearing the interval is not optional. Without it the timer keeps
      // firing after the component unmounts, polling the backend forever from a
      // page nobody is looking at.
      clearInterval(id);
    };
  }, []);

  const rows: Array<[string, string, Tone]> = data
    ? [
        ["runs.active", String(data.runs_active), "success"],
        // THRESHOLD-DRIVEN TONES: these two rows turn amber past a limit, so a
        // backed-up queue or a slow gate is visible without reading the number.
        ["runs.queued", String(data.runs_queued), data.runs_queued > 4 ? "warning" : "muted"],
        ["reviewers.online", String(data.reviewers_online), "success"],
        [
          "gate.latency",
          `${data.gate_latency_ms}ms`,
          data.gate_latency_ms > 240 ? "warning" : "success",
        ],
        ["steps.per_min", String(data.steps_per_min), "success"],
        ["spend.per_hr", `$${data.spend_per_hr.toFixed(2)}`, "muted"],
      ]
    // SKELETON ROWS while loading: six placeholder rows of em dashes, matching
    // the six real rows above. This keeps the panel's height identical before
    // and after data arrives, so the page does not jump when the first poll
    // lands. `Array.from({ length: 6 })` is the idiom for "make an array of n
    // items" — the keys are indexed to stay unique.
    : (Array.from({ length: 6 }).map((_, i) => [`—${i}`, "—", "muted"]) as Array<
        [string, string, Tone]
      >);

  return (
    <Section id="telemetry">
      <div className={GRID}>
        <div className="col-span-12 panel p-6">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-panel-border pb-4">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <Chip tone={err ? "error" : "success"}>live fleet telemetry</Chip>
              <span className="truncate font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground">
                {data ? `edge · ${data.region} · ${data.build}` : err ? "reconnecting…" : "syncing…"}
              </span>
            </div>
            <span className="hidden shrink-0 font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground sm:block">
              GET /api/status · polled 5s
            </span>
          </div>

          <div className="mt-5 grid grid-cols-12 gap-3">
            {rows.map(([k, v, tone], i) => (
              <div
                key={`${k}-${i}`}
                className="col-span-6 rounded-md border border-panel-border bg-background/40 p-3 sm:col-span-4 lg:col-span-2"
              >
                <div className="flex h-4 items-center gap-2 font-mono text-[10px] tracking-[0.14em] text-muted-foreground">
                  <StatusDot tone={tone} /> <span className="truncate">{data ? k : "—"}</span>
                </div>
                <div className="mt-1.5 font-mono text-sm text-foreground">{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ---------- CTA ---------- */

function CTA() {
  return (
    <Section>
      <div className={`${GRID} items-end`}>
        <div className="col-span-12 min-w-0 lg:col-span-7">
          <h2
            className="font-serif leading-[1.05] tracking-[-0.02em] text-foreground"
            style={{ fontSize: "clamp(1.8rem, 3.2vw, 2.75rem)" }}
          >
            Point it at your backend and start a run.
          </h2>
          <p className="mt-4 max-w-[52ch] text-muted-foreground">
            The console needs an API base URL for the FastAPI runner. Set it once in the connection
            panel, then enable a provider key — every run is real and human-gated.
          </p>
        </div>
        <div className="col-span-12 flex flex-wrap gap-3 lg:col-span-4 lg:col-start-9 lg:justify-end">
          <Link
            to="/auth"
            className="inline-flex h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-95"
          >
            Open the console
          </Link>
          <Link
            to="/changelog"
            className="inline-flex h-11 items-center rounded-md border border-panel-border bg-panel/60 px-5 text-sm text-foreground hover:border-foreground/40"
          >
            Changelog
          </Link>
        </div>
      </div>
    </Section>
  );
}

/* ---------- footer ---------- */

function Footer() {
  return (
    <footer className="border-t border-border/60">
      <Shell>
        <div className={`${GRID} items-center py-8`}>
          <div className="col-span-6 lg:col-span-4">
            <Logomark />
          </div>
          <div className="col-span-4 hidden justify-center gap-6 font-mono text-[11px] tracking-[0.14em] text-muted-foreground lg:flex">
            <a href="#workflow" className="hover:text-foreground">
              workflow
            </a>
            <a href="#controls" className="hover:text-foreground">
              controls
            </a>
            <a href="#telemetry" className="hover:text-foreground">
              telemetry
            </a>
          </div>
          <div className="col-span-6 text-right font-mono text-[11px] tracking-[0.14em] text-muted-foreground lg:col-span-4">
            agentlab · build 2026.04
          </div>
        </div>
      </Shell>
    </footer>
  );
}

/* ---------- page ---------- */

function Landing() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <Nav />
      <Hero />
      <Workflow />
      <Controls />
      <LiveTelemetry />
      <CTA />
      <Footer />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{ style: { fontFamily: "var(--font-mono)" } }}
      />
    </div>
  );
}
