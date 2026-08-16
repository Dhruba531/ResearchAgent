// Search controller. Start/stop, budgets, exploration rate,
// edit-family weights, stopping criteria, and live campaign vitals.
//
// The most COMPLEX FORM in the campaign folder, and the one that spends money —
// pressing Start launches a search that consumes real provider credits.
//
// Patterns worth studying here:
//   • a single `draft` state object holding the whole form, updated immutably
//   • disabling every input while a campaign is live, so settings cannot change
//     under a running search
//   • two small private helpers (`Field`, `NumberInput`) removing repetition
//     across a dozen inputs
//
// The domain idea behind "exploration rate" and "family weights": a search must
// balance EXPLOITATION (refine the best candidate so far) against EXPLORATION
// (try something different). Too much exploitation and it polishes a local
// optimum forever; too much exploration and it never builds on what works.
// These controls set that balance before the run starts.

import { useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  startCampaign,
  stopCampaign,
  type CampaignBudget,
  type CampaignOut,
} from "@/lib/api";
import { Chip, Panel, PanelHead, Stat, fmtNum, fmtUsd } from "./primitives";

// The kinds of change the proposer can make. Exported so other surfaces can
// render the same list without redefining it.
export const DEFAULT_FAMILIES = [
  "architecture",
  "optimizer",
  "data",
  "loss",
  "regularization",
  "schedule",
];

/**
 * The whole form as ONE state object.
 *
 * The alternative — six separate `useState` calls — would mean six setters
 * threaded through the JSX and six values to bundle up when submitting. A
 * single object keeps related fields together and makes `emptyDraft()` a
 * complete, obvious reset.
 */
export interface ControllerDraft {
  budget: CampaignBudget;
  maxIters: number;
  explore: number;
  weights: Record<string, number>;
  stagnation: number;
  maxInvalidRate: number;
}

/**
 * Fresh default settings.
 *
 * A FUNCTION, not a shared constant, and that matters: it returns a NEW object
 * every call. A module-level `const emptyDraft = {...}` would be one object
 * shared by every component instance, so editing the form in one place would
 * mutate the defaults for everywhere else.
 */
export const emptyDraft = (): ControllerDraft => ({
  // Conservative starting caps — deliberately modest, since these are real
  // spending limits and the safer default is one that stops early.
  budget: { usd: 50, gpu_hours: 4, model_calls: 400, wall_clock_minutes: 180 },
  maxIters: 40,
  // 0.3 leans toward exploitation: mostly refine the incumbent, occasionally
  // branch elsewhere.
  explore: 0.3,
  // `Object.fromEntries` is the inverse of `Object.entries`: it turns
  // [["architecture", 1], ["optimizer", 1], …] into an object. Every family
  // starts at weight 1, i.e. equally likely.
  weights: Object.fromEntries(DEFAULT_FAMILIES.map((f) => [f, 1])),
  // Stop after 8 iterations with no improvement — the stagnation signal that
  // `progress-curve.tsx` visualises as a long flat line.
  stagnation: 8,
  // Stop if more than 35% of candidates fail to evaluate: the proposer has
  // drifted into producing broken code and is burning budget for nothing.
  maxInvalidRate: 0.35,
});

export function SearchController({
  campaign,
  projectId,
  onChanged,
}: {
  campaign: CampaignOut | null;
  projectId: number | null;
  onChanged: (c: CampaignOut) => void;
}) {
  // `useState(emptyDraft())` calls the function on EVERY render and throws the
  // result away after the first — React only uses the initial value once.
  // Harmless for something this cheap; for expensive initial state the lazy
  // form `useState(emptyDraft)` (passing the function itself) avoids the waste.
  const [draft, setDraft] = useState<ControllerDraft>(emptyDraft());
  const [busy, setBusy] = useState(false);

  // `live` gates the entire form — see the `disabled={live}` on every input
  // below. Settings must not change under a running search, or the displayed
  // configuration would no longer describe what is actually executing.
  const live = campaign?.status === "running" || campaign?.status === "queued";
  const spend = campaign?.spend;
  // Show the RUNNING campaign's caps when there is one, otherwise the draft's.
  // That way the vitals row above compares spend against the limits actually in
  // force, not against unsaved edits in the form.
  const cap = campaign?.config?.budget ?? draft.budget;

  /** Launch a campaign with the current draft settings. Spends real money. */
  const start = async () => {
    // Guard before touching any loading state, so an early return cannot leave
    // `busy` stuck true.
    if (projectId == null) {
      toast.error("Select a project first");
      return;
    }
    setBusy(true);
    try {
      const c = await startCampaign(projectId, {
        budget: draft.budget,
        maxIters: draft.maxIters,
        explore: draft.explore,
        editFamilies: draft.weights,
        stopping: {
          stagnation_iters: draft.stagnation,
          max_invalid_rate: draft.maxInvalidRate,
        },
      });
      // Hand the new campaign up to the parent — same callback-prop pattern as
      // `onUpdated` in governance.tsx.
      onChanged(c);
      toast.success(`Campaign #${c.id} queued`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start campaign");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      const c = await stopCampaign(campaign.id);
      onChanged(c);
      // The wording is precise on purpose: stopping is NOT immediate. The
      // current evaluation finishes first, so a user who expects an instant
      // halt is not left thinking the button failed.
      toast.success("Stop requested — the loop halts after the current evaluation");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not stop campaign");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHead
        kicker="search · controller"
        title="Search budget & exploration"
        subtitle="Hard caps stop the loop; exploration rate and family weights steer what the proposer tries next."
        meta={
          <Chip tone={live ? "success" : "muted"}>
            {campaign ? `${campaign.status} · iter ${campaign.iteration}` : "idle"}
          </Chip>
        }
      />

      {/* LIVE VITALS, shown only once a campaign exists. Each Stat pairs a
          current value with its cap, so "spend $12.40 / $50.00" answers
          "how much runway is left?" at a glance. */}
      {campaign && (
        <div className="grid gap-3 border-b border-panel-border px-6 py-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="iteration"
            value={`${campaign.iteration}${cap.max_iters ? ` / ${cap.max_iters}` : ""}`}
            hint={`stagnation ${campaign.metrics?.stagnation_counter ?? 0}`}
          />
          <Stat label="best score" value={fmtNum(campaign.best_score)} hint={campaign.best_candidate_id ? `c${campaign.best_candidate_id}` : "—"} />
          <Stat
            label="invalid rate"
            value={`${Math.round((campaign.metrics?.invalid_rate ?? 0) * 100)}%`}
            hint={`hit rate ${Math.round((campaign.metrics?.hit_rate ?? 0) * 100)}%`}
          />
          <Stat
            label="spend"
            value={`${fmtUsd(spend?.usd ?? 0)}${cap.usd ? ` / ${fmtUsd(cap.usd)}` : ""}`}
            hint={`${fmtNum(spend?.gpu_hours ?? 0, 2)} gpu-hr · ${spend?.model_calls ?? 0} calls`}
          />
        </div>
      )}

      <div className="grid gap-6 px-6 py-6 lg:grid-cols-2">
        <div className="space-y-4">
          {/* IMMUTABLE NESTED UPDATE — the key pattern in this form, and the
              thing to take away from this file.

              `setDraft((d) => ({ ...d, maxIters: v }))` builds a NEW object
              copying every field, then overrides one. React compares state by
              identity, so mutating `draft.maxIters = v` directly would change
              the value without changing the object, and nothing would re-render.

              Nested objects need the same treatment at each level: note
              `budget: { ...d.budget, max_iters: v }` spreads the inner object
              too. Writing `d.budget.max_iters = v` would mutate the existing
              budget in place — the classic React state bug.

              This particular field writes to two places, keeping `maxIters` and
              `budget.max_iters` in sync because the API expects both. */}
          <Field label="max iterations">
            <NumberInput
              value={draft.maxIters}
              onChange={(v) => setDraft((d) => ({ ...d, maxIters: v, budget: { ...d.budget, max_iters: v } }))}
              disabled={live}
            />
          </Field>
          <Field label="wall clock (min)">
            <NumberInput
              value={draft.budget.wall_clock_minutes ?? 0}
              onChange={(v) => setDraft((d) => ({ ...d, budget: { ...d.budget, wall_clock_minutes: v } }))}
              disabled={live}
            />
          </Field>
          <Field label="model calls">
            <NumberInput
              value={draft.budget.model_calls ?? 0}
              onChange={(v) => setDraft((d) => ({ ...d, budget: { ...d.budget, model_calls: v } }))}
              disabled={live}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="gpu hours">
              <NumberInput
                value={draft.budget.gpu_hours ?? 0}
                step={0.5}
                onChange={(v) => setDraft((d) => ({ ...d, budget: { ...d.budget, gpu_hours: v } }))}
                disabled={live}
              />
            </Field>
            <Field label="usd cap">
              <NumberInput
                value={draft.budget.usd ?? 0}
                onChange={(v) => setDraft((d) => ({ ...d, budget: { ...d.budget, usd: v } }))}
                disabled={live}
              />
            </Field>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between">
              <span className="mono-label">exploration rate</span>
              <span className="font-mono text-[12px] text-foreground">
                {draft.explore.toFixed(2)}
              </span>
            </div>
            {/* Radix Slider takes an ARRAY for `value` and passes an array to
                `onValueChange`, because the same component supports range
                sliders with two handles. With one handle it is a one-element
                array — hence `[draft.explore]` going in and the destructured
                `([v])` coming back out. */}
            <Slider
              className="mt-3"
              value={[draft.explore]}
              min={0}
              max={1}
              step={0.05}
              disabled={live}
              onValueChange={([v]) => setDraft((d) => ({ ...d, explore: v }))}
            />
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              0 = always branch from the incumbent · 1 = uniform sampling across the archive.
            </p>
          </div>

          <div>
            <span className="mono-label">edit-family weights</span>
            <div className="mt-3 space-y-2">
              {/* One slider per edit family, generated from the weights
                  object. Raising a family's weight makes the proposer try that
                  kind of change more often — useful when you already suspect
                  the gains are in, say, the optimizer rather than the
                  architecture. */}
              {Object.entries(draft.weights).map(([family, w]) => (
                <div key={family} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 font-mono text-[11.5px] text-muted-foreground">
                    {family}
                  </span>
                  <Slider
                    value={[w]}
                    min={0}
                    max={3}
                    step={0.25}
                    disabled={live}
                    // `[family]: v` is a COMPUTED PROPERTY KEY — the brackets
                    // mean "use the value of the `family` variable as the key",
                    // rather than the literal string "family". Combined with
                    // the spread, this updates one entry and copies the rest.
                    onValueChange={([v]) =>
                      setDraft((d) => ({ ...d, weights: { ...d.weights, [family]: v } }))
                    }
                  />
                  <span className="w-8 text-right font-mono text-[11.5px] text-foreground">
                    {w.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="stop after stagnation (iters)">
              <NumberInput
                value={draft.stagnation}
                onChange={(v) => setDraft((d) => ({ ...d, stagnation: v }))}
                disabled={live}
              />
            </Field>
            <Field label="max invalid rate">
              <NumberInput
                value={draft.maxInvalidRate}
                step={0.05}
                onChange={(v) => setDraft((d) => ({ ...d, maxInvalidRate: v }))}
                disabled={live}
              />
            </Field>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-panel-border px-6 py-4">
        {/* Stated plainly next to the button that triggers the spending. */}
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
          budgets are hard caps — the loop halts on the first breach
        </p>
        <div className="flex gap-2">
          {/* Three independent reasons to block Start: a request is already in
              flight, a campaign is already running, or no project is selected.
              Note the buttons are mutually exclusive by construction — Start
              requires `!live`, Stop requires `live`. */}
          <Button onClick={start} disabled={busy || live || projectId == null} size="sm">
            {busy && !live ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Start campaign
          </Button>
          <Button onClick={stop} disabled={busy || !live} size="sm" variant="outline">
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        </div>
      </div>
    </Panel>
  );
}

// ── Private helpers ───────────────────────────────────────────────────────

/**
 * A labelled form field.
 *
 * Wrapping the control in a <label> is an accessibility detail worth copying:
 * clicking the label focuses the input, and screen readers announce the two
 * together. It also avoids needing matching `htmlFor`/`id` attributes, since
 * nesting establishes the association implicitly.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-label">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

/**
 * A numeric input that hands back a `number` rather than a string.
 *
 * The reason this wrapper exists: `e.target.value` from a DOM input is ALWAYS a
 * string, even with `type="number"`. Without the `Number()` conversion, "40"
 * would flow into state and `"40" + 1` would produce "401" rather than 41.
 * Converting once here means every call site receives a real number.
 *
 * (Worth knowing the edge case: an empty field yields `Number("") === 0`, so
 * clearing an input reads as zero rather than as "unset".)
 */
function NumberInput({
  value,
  onChange,
  step = 1,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <Input
      type="number"
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-9 font-mono text-[13px]"
    />
  );
}
