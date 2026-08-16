// Candidate detail viewer.
// Tabs: Diff · Metrics · Logs · Traces · Notes.
//
// The deepest view in the app: everything recorded about one candidate.
//
// STRUCTURE — this file is one exported component plus SIX private helpers
// (Metric, Note, LogBlock, TraceRow, Block, TreeNode) defined below it. That
// layout is worth noticing: the exported component reads as an outline, and
// each helper handles one repeated piece of markup. It is the same instinct
// behind `primitives.tsx`, applied at file scope for components too specific to
// share.
//
// The "Traces" tab is the interesting one. It shows what the AI agent actually
// did — its prompts, its raw output, and each tool call with inputs and
// outputs. That is the audit trail behind a candidate's score.

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CandidateOut, CandidateTraceOut, TraceFileNode, TraceStep } from "@/lib/api";
import { DiffView } from "./diff-view";
import { Chip, EmptyState, Panel, PanelHead, StatusPill, fmtNum, fmtUsd } from "./primitives";

export function CandidateDetail({
  candidate,
  // The trace is fetched SEPARATELY from the candidate (see `useCandidateTrace`
  // in lib/campaign-queries.ts, which is lazily enabled). It is large, so it
  // loads on demand — hence a nullable value plus its own loading flag, rather
  // than one combined object.
  trace,
  traceLoading,
}: {
  candidate: CandidateOut;
  trace: CandidateTraceOut | null | undefined;
  traceLoading: boolean;
}) {
  return (
    <Panel>
      <PanelHead
        kicker={`candidate c${candidate.id} · iteration ${candidate.iteration}`}
        title={`${candidate.edit_family} edit`}
        subtitle={
          candidate.parent_id != null
            ? `Branched from c${candidate.parent_id}.`
            : "Root candidate — the seed program."
        }
        meta={
          <>
            <StatusPill status={candidate.status} />
            <Chip tone="info">score {fmtNum(candidate.score)}</Chip>
          </>
        }
      />
      {/* Radix Tabs via shadcn/ui. `defaultValue` makes this UNCONTROLLED —
          Radix owns which tab is active, and this component never tracks it in
          state. Right choice here: nothing else needs to know. Contrast
          `campaigns.$id.tsx`, which does control its tabs so the selection can
          live in the URL and survive a refresh.

          Radix also supplies the keyboard behaviour (arrow keys between tabs)
          and the ARIA wiring that makes the tab list announce correctly. */}
      <Tabs defaultValue="diff">
        <div className="border-b border-panel-border px-6 pt-4">
          <TabsList className="bg-transparent p-0">
            {/* Triggers generated from an array so the five tabs cannot drift
                out of sync in styling. The strings double as both the `value`
                and the visible label. */}
            {["diff", "metrics", "logs", "traces", "notes"].map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                // `data-[state=active]:` is Tailwind styling a DATA
                // ATTRIBUTE. Radix sets data-state="active" on the selected
                // trigger, and this styles that state directly in the class
                // list — no conditional className, no state read. This pattern
                // is everywhere in shadcn/ui components.
                //
                // The transparent 2px bottom border reserves space so the
                // active underline appears without shifting the layout.
                className="rounded-none border-b-2 border-transparent px-3 pb-2 font-mono text-[11px] uppercase tracking-[0.14em] data-[state=active]:border-primary data-[state=active]:bg-transparent"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="diff" className="m-0">
          <DiffView diff={candidate.diff} />
        </TabsContent>

        <TabsContent value="metrics" className="m-0 px-6 py-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Metric label="score" value={fmtNum(candidate.score)} />
            {/* `Object.entries(obj)` turns { usd: 3.2, gpu_hours: 1.1 } into
                [["usd", 3.2], ["gpu_hours", 1.1]] so it can be mapped over.
                The destructured `[k, v]` is the key/value pair.

                This renders whatever fields the backend sent, rather than a
                fixed list — so a new cost dimension appears automatically with
                no frontend change. The `?? {}` guards against a null field:
                `Object.entries(null)` throws. */}
            {Object.entries(candidate.cost_vector ?? {}).map(([k, v]) => (
              <Metric key={k} label={k} value={k === "usd" ? fmtUsd(v ?? null) : fmtNum(v ?? null, 2)} />
            ))}
            {Object.entries(candidate.metrics ?? {}).map(([k, v]) => (
              <Metric key={k} label={k} value={typeof v === "number" ? fmtNum(v) : String(v ?? "—")} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="logs" className="m-0">
          {/* stderr is tinted red — it is where a failed candidate explains
              itself, and it should be findable at a glance. */}
          <LogBlock title="stdout" body={trace?.stdout} loading={traceLoading} />
          <LogBlock title="stderr" body={trace?.stderr} loading={traceLoading} tone="danger" />
        </TabsContent>

        <TabsContent value="traces" className="m-0">
          {/* A three-way conditional via chained ternaries: loading, then
              empty, then content. Handling "loading" and "empty" as distinct
              states matters — showing "no trace steps" while data is still in
              flight would be actively wrong. */}
          {traceLoading ? (
            <EmptyState label="loading trace…" />
          ) : !trace || trace.steps.length === 0 ? (
            <EmptyState
              label="no trace steps"
              hint={candidate.trace_dir ? `archive: ${candidate.trace_dir}` : undefined}
            />
          ) : (
            // `divide-y` draws a border BETWEEN children only — no stray line
            // above the first or below the last. Cleaner than putting a border
            // on each row and then removing one.
            <div className="divide-y divide-panel-border">
              {trace.steps.map((s) => (
                <TraceRow key={s.step} step={s} />
              ))}
            </div>
          )}
          {/* The archive file tree, rendered recursively by `TreeNode` below.
              Both conditions are needed: `trace?.tree` for existence, then the
              length check so an empty array does not render a bare heading. */}
          {trace?.tree && trace.tree.length > 0 && (
            <div className="border-t border-panel-border px-6 py-5">
              <div className="mono-label">archive files</div>
              <ul className="mt-2 space-y-1">
                {trace.tree.map((n) => (
                  <TreeNode key={n.path} node={n} depth={0} />
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        {/* The agent's own reasoning, in scientific-method order: what it
            expected, what happened, what it concluded. This is what makes a
            failed candidate informative rather than merely a wasted run. */}
        <TabsContent value="notes" className="m-0 space-y-4 px-6 py-5">
          <Note label="hypothesis" body={candidate.notes?.hypothesis} />
          <Note label="result" body={candidate.notes?.result} />
          <Note label="interpretation" body={candidate.notes?.interpretation} />
        </TabsContent>
      </Tabs>
    </Panel>
  );
}

// ── Private helpers ───────────────────────────────────────────────────────
// None of these are exported: they exist only for this file. Keeping them here
// rather than in `primitives.tsx` is the right call while they have exactly one
// consumer — promote them if a second file ever needs them.

/** One metric tile. Similar to `Stat` in primitives.tsx, minus the hint. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-panel-border bg-background/40 p-3">
      {/* Backend keys are snake_case; this renders "gpu_hours" as "gpu hours".
          The `g` flag replaces every underscore, not just the first. */}
      <div className="mono-label">{label.replace(/_/g, " ")}</div>
      <div className="mt-1.5 font-mono text-[15px] text-foreground">{value}</div>
    </div>
  );
}

/** A labelled prose block, falling back to an em dash when empty. */
function Note({ label, body }: { label: string; body?: string }) {
  return (
    <div>
      <div className="mono-label">{label}</div>
      {/* `?.trim() || "—"` handles three cases at once: undefined, empty, and
          whitespace-only all fall through to the dash. `||` rather than `??`
          is deliberate — `??` would let an empty string through. */}
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
        {body?.trim() || "—"}
      </p>
    </div>
  );
}

/** A scrollable stdout/stderr pane. */
function LogBlock({
  title,
  body,
  loading,
  // Typed `"danger"` rather than boolean `isError`, leaving room for more tones
  // later without changing the call sites.
  tone,
}: {
  title: string;
  body?: string;
  loading: boolean;
  tone?: "danger";
}) {
  return (
    <div className="border-b border-panel-border last:border-b-0">
      <div className="flex items-center justify-between px-6 py-3">
        <span className="mono-label">{title}</span>
      </div>
      <pre
        className={`max-h-[280px] overflow-auto bg-background/60 px-6 pb-5 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap ${tone === "danger" ? "text-destructive/90" : "text-foreground/75"}`}
      >
        {loading ? "loading…" : body?.trim() || "— empty —"}
      </pre>
    </div>
  );
}

/**
 * One step of the agent's execution trace, collapsed by default.
 *
 * Uses the native HTML <details>/<summary> elements rather than a React
 * accordion — no state, no JavaScript, keyboard-accessible for free, and the
 * browser handles expand/collapse. Reach for this before writing a component.
 */
function TraceRow({ step }: { step: TraceStep }) {
  // Parser status reports whether the model's output could be parsed as
  // intended: clean, auto-repaired, or failed outright. A run full of
  // "repaired" steps means the model is drifting from the expected format.
  const parserTone =
    step.parser_status === "failed"
      ? "text-destructive"
      : step.parser_status === "repaired"
        ? "text-warning"
        : "text-success";
  return (
    <details className="group px-6 py-4">
      {/* `cursor-pointer` is needed because <summary> does not signal
          clickability by default in every browser. */}
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 font-mono text-[12px]">
        {/* Zero-padded so step numbers align in a monospace column: 01, 02, …
            10. Without padding the single digits would sit ragged. */}
        <span className="text-muted-foreground">#{String(step.step).padStart(2, "0")}</span>
        <span className="rounded border border-panel-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-primary">
          {step.phase ?? "step"}
        </span>
        {step.tool && <span className="text-foreground/80">{step.tool}</span>}
        {step.parser_status && <span className={parserTone}>parser: {step.parser_status}</span>}
        {/* `ml-auto` in a flex row pushes this element to the far right by
            absorbing all the free space to its left — the standard way to
            right-align one flex item. */}
        <span className="ml-auto text-muted-foreground">
          {step.duration_ms != null ? `${step.duration_ms}ms` : ""}
          {step.tokens != null ? ` · ${step.tokens} tok` : ""}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {step.prompt && <Block label="prompt" body={step.prompt} />}
        {step.model_output && <Block label="model output" body={step.model_output} />}
        {/* Tool calls: what the agent asked for and what came back. The
            `null, 2` argument pretty-prints the JSON across lines, which the
            `whitespace-pre-wrap` in `Block` then preserves. */}
        {step.tool_calls?.map((tc, i) => (
          <Block
            key={i}
            label={`tool call · ${tc.name}`}
            body={`input: ${JSON.stringify(tc.input, null, 2)}\noutput: ${JSON.stringify(tc.output, null, 2)}`}
          />
        ))}
      </div>
    </details>
  );
}

/** A labelled, scrollable preformatted block. Used for prompts and outputs. */
function Block({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-md border border-panel-border bg-background/40">
      <div className="border-b border-panel-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <pre className="max-h-[220px] overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-foreground/80">
        {body}
      </pre>
    </div>
  );
}

/**
 * A RECURSIVE COMPONENT — it renders itself for each child, which is how an
 * arbitrarily deep directory tree is drawn without knowing its depth in
 * advance. The recursion terminates naturally at files, which have no children.
 *
 * `depth` is threaded down purely to compute indentation.
 */
function TreeNode({ node, depth }: { node: TraceFileNode; depth: number }) {
  return (
    <li>
      <div
        className="font-mono text-[11.5px] text-muted-foreground"
        // An inline style, not a Tailwind class, because the value is computed
        // at runtime — Tailwind cannot generate `pl-[${depth * 14}px]`. Same
        // constraint as the legend swatch in progress-curve.tsx.
        style={{ paddingLeft: depth * 14 }}
      >
        {node.type === "dir" ? "▸" : "·"} {node.name}
        {node.size_bytes != null && node.type === "file" && (
          <span className="text-muted-foreground/50"> ({node.size_bytes} B)</span>
        )}
      </div>
      {/* THE RECURSIVE CALL. `?.` means a file (no children array) simply
          renders nothing further. `depth + 1` indents the next level. Keyed by
          `path`, which is unique across the whole tree — unlike `name`, which
          repeats across directories. */}
      {node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
    </li>
  );
}
