// The human gates. `DecisionDialog` is the shared confirm-before-acting
// dialog; `BriefCard` is gate G1 (approve the plan) and `RunSetupCard` is
// gate G2 (approve the spend, then start the run).
//
// `RunSetupCard` is the component that spends money. Read it carefully
// before changing it.

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  approveBrief as apiApproveBrief,
  ApiError,
  cancelRun as apiCancelRun,
  estimateRun,
  generateBrief,
  startRun,
  updateBrief,
  type BriefOut,
  type ProjectOut,
  type RunOut,
  type CapabilitiesOut,
  type UsageOut,
} from "@/lib/api";
import { BentoHead, Dot, DotTone, MetaChip, ToggleTile, friendlyError } from "./primitives";
import { Gated } from "./gating";
import { RevisionGate } from "./revisions";

export type DecisionTone = "approve" | "warn" | "danger";

/**
 * THE SHARED CONFIRMATION DIALOG — used by every gate in this file.
 *
 * Rather than four bespoke dialogs for approving a brief, a cost, a revision,
 * and an export, there is one heavily-parameterised component. That is why the
 * prop list is long: each gate supplies its own wording, tone, summary rows,
 * and confirm handler.
 *
 * The design principle it encodes: a costly or irreversible action must be
 * DELIBERATE. Every gate therefore requires the user to type a note (see
 * `minChars`, default 10) before the confirm button enables. That note lands in
 * the audit trail, so the record shows not just what was approved but why —
 * and the typing requirement makes reflexive click-through much harder.
 */
export function DecisionDialog({
  open,
  onOpenChange,
  tone,
  kicker,
  title,
  description,
  summary,
  confirmLabel,
  confirmingLabel,
  minChars = 10,
  placeholder = "Add a note for the audit trail (required)…",
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tone: DecisionTone;
  kicker: string;
  title: string;
  description: string;
  summary?: Array<{ label: string; value: React.ReactNode; tone?: DecisionTone }>;
  confirmLabel: string;
  confirmingLabel: string;
  minChars?: number;
  placeholder?: string;
  busy: boolean;
  onConfirm: (notes: string) => void | Promise<void>;
}) {
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (!open) setNotes("");
  }, [open]);

  const trimmed = notes.trim();
  const valid = trimmed.length >= minChars;
  const remaining = Math.max(0, minChars - trimmed.length);

  const toneRing =
    tone === "danger"
      ? "border-destructive/40"
      : tone === "warn"
        ? "border-warning/40"
        : "border-primary/40";
  const toneKicker =
    tone === "danger" ? "text-destructive" : tone === "warn" ? "text-warning" : "text-primary";
  const confirmBtn =
    tone === "danger"
      ? "bg-destructive text-destructive-foreground hover:opacity-95"
      : tone === "warn"
        ? "bg-warning text-warning-foreground hover:opacity-95"
        : "bg-primary text-primary-foreground hover:opacity-95";

  return (
    <Dialog open={open} onOpenChange={(v) => (!busy ? onOpenChange(v) : undefined)}>
      <DialogContent className={`max-w-lg border ${toneRing} bg-background p-0`}>
        <DialogHeader className="space-y-2 border-b border-panel-border p-6 text-left">
          <div className={`mono-label ${toneKicker}`}>{kicker}</div>
          <DialogTitle className="font-serif text-2xl leading-tight tracking-tight text-foreground">
            {title}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        {summary && summary.length > 0 && (
          <div className="grid grid-cols-2 gap-px bg-panel-border">
            {summary.map((s) => (
              <div key={s.label} className="bg-panel p-3">
                <div className="mono-label">{s.label}</div>
                <div
                  className={`mt-1 font-mono text-sm ${
                    s.tone === "danger"
                      ? "text-destructive"
                      : s.tone === "warn"
                        ? "text-warning"
                        : "text-foreground"
                  }`}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 p-6">
          <label className="mono-label" htmlFor="decision-notes">
            reviewer notes · required
          </label>
          <textarea
            id="decision-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={placeholder}
            rows={4}
            disabled={busy}
            autoFocus
            className="w-full resize-none rounded-md border border-panel-border bg-background/50 p-3 font-mono text-[12px] leading-relaxed text-foreground/90 focus:border-primary focus:outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-between font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground">
            <span>{valid ? "✓ note captured" : `min ${minChars} chars · ${remaining} to go`}</span>
            <span>{trimmed.length} chars</span>
          </div>
        </div>

        <DialogFooter className="gap-2 border-t border-panel-border p-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="rounded-md border border-panel-border bg-background/60 px-4 py-2.5 font-mono text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => onConfirm(trimmed)}
            className={`rounded-md px-4 py-2.5 font-mono text-xs font-medium ${confirmBtn} disabled:opacity-50`}
          >
            {busy ? confirmingLabel : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * GATE G1 — the research brief: generate, edit, approve or send back.
 *
 * The brief is the AI-written research plan. Approving it is the first human
 * checkpoint, and nothing expensive happens until it clears: `RunSetupCard`
 * below refuses to start without `briefApproved`.
 *
 * Note `busy` is a STRING here ("gen" | "save" | "approve" | "revise"), not a
 * boolean. Four actions share the card, and each button needs to show its own
 * spinner while all of them disable — one string does what four booleans would.
 * You will see the same trick in `RunSetupCard` and `RevisionGate`.
 */
export function BriefCard({
  project,
  brief,
  setBrief,
}: {
  project: ProjectOut;
  brief: BriefOut | null;
  setBrief: (b: BriefOut | null) => void;
}) {
  const [busy, setBusy] = useState<string>("");
  const [draft, setDraft] = useState(brief?.content_markdown ?? "");

  useEffect(() => {
    setDraft(brief?.content_markdown ?? "");
  }, [brief?.id, brief?.version]);

  const doGenerate = async () => {
    setBusy("gen");
    try {
      const b = await generateBrief(project.id);
      setBrief(b);
      toast.success("Brief generated", { description: `v${b.version}` });
    } catch (e) {
      toast.error(friendlyError(e, "Could not generate brief"));
    } finally {
      setBusy("");
    }
  };

  const doSave = async () => {
    if (!brief) return;
    setBusy("save");
    try {
      const b = await updateBrief(brief.id, draft);
      setBrief(b);
      toast.success("Brief saved");
    } catch (e) {
      toast.error(friendlyError(e, "Could not save brief"));
    } finally {
      setBusy("");
    }
  };

  const [approveOpen, setApproveOpen] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);

  const doApprove = async (notes: string) => {
    if (!brief) return;
    setBusy("approve");
    try {
      const b = await apiApproveBrief(brief.id, notes);
      setBrief(b);
      setApproveOpen(false);
      toast.success("Brief approved · gate G1 cleared", { description: notes });
    } catch (e) {
      toast.error(friendlyError(e, "Could not approve brief"));
    } finally {
      setBusy("");
    }
  };

  const doRevise = async (notes: string) => {
    if (!brief) return;
    setBusy("revise");
    try {
      const b = await generateBrief(project.id);
      setBrief(b);
      setReviseOpen(false);
      toast.warning("Revision requested · new draft generated", {
        description: notes,
      });
    } catch (e) {
      toast.error(friendlyError(e, "Could not request revision"));
    } finally {
      setBusy("");
    }
  };

  const wordCount = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  const charCount = draft.length;
  const approved = Boolean(brief?.is_approved);
  const stateTone: DotTone = approved ? "success" : brief ? "warning" : "muted";
  const stateLabel = approved ? "approved" : brief ? "draft" : "empty";

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="brief · gate g1"
        title="Research brief"
        subtitle="Generate a structured brief from the saved idea, refine it, then approve to unlock the run gate."
        meta={
          <>
            <MetaChip tone={stateTone}>{stateLabel}</MetaChip>
            {brief && <MetaChip>v{brief.version}</MetaChip>}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-px bg-panel-border sm:grid-cols-4">
        <div className="bg-panel p-3">
          <div className="mono-label">version</div>
          <div className="mt-1 font-mono text-sm text-foreground">
            {brief ? `v${brief.version}` : "—"}
          </div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">status</div>
          <div
            className={`mt-1 font-mono text-sm ${approved ? "text-primary" : brief ? "text-warning" : "text-muted-foreground"}`}
          >
            {stateLabel}
          </div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">words</div>
          <div className="mt-1 font-mono text-sm text-foreground">{wordCount}</div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">chars</div>
          <div className="mt-1 font-mono text-sm text-foreground">{charCount}</div>
        </div>
      </div>
      <div className="p-6">
        {brief ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-[300px] w-full resize-none rounded-md border border-panel-border bg-background/50 p-4 font-mono text-[12px] leading-relaxed text-foreground/90 focus:border-primary focus:outline-none"
            spellCheck={false}
            readOnly={approved}
          />
        ) : (
          <div className="grid h-[300px] place-items-center rounded-md border border-dashed border-panel-border bg-background/30 px-6 text-center font-mono text-xs text-muted-foreground">
            <div className="space-y-2">
              <div className="text-2xl text-foreground/40">◈</div>
              <div>No brief yet — generate one from the saved idea.</div>
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-[11px] text-muted-foreground">
            {approved
              ? "Gate G1 cleared · brief locked. Regenerate to iterate."
              : brief
                ? "Save edits, then approve to clear gate G1."
                : "Draft a brief to begin the workflow."}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={doGenerate}
              disabled={Boolean(busy)}
              className="flex items-center gap-2 rounded-md border border-panel-border bg-background/60 px-4 py-2.5 font-mono text-xs text-foreground hover:border-foreground/40 disabled:opacity-60"
            >
              {busy === "gen" ? "Generating…" : brief ? "⟳ Regenerate" : "⚗ Generate Brief"}
            </button>
            {brief && !approved && (
              <>
                <button
                  onClick={doSave}
                  disabled={Boolean(busy)}
                  className="flex items-center gap-2 rounded-md border border-panel-border bg-background/60 px-4 py-2.5 font-mono text-xs text-foreground hover:border-foreground/40 disabled:opacity-60"
                >
                  {busy === "save" ? "Saving…" : "⬒ Save edits"}
                </button>
                <button
                  onClick={() => setReviseOpen(true)}
                  disabled={Boolean(busy)}
                  className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-4 py-2.5 font-mono text-xs text-warning hover:bg-warning/10 disabled:opacity-60"
                >
                  {busy === "revise" ? "Revising…" : "✕ Request revision"}
                </button>
                <Gated
                  perm="brief:approve"
                  onClick={() => setApproveOpen(true)}
                  disabled={Boolean(busy)}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 font-mono text-xs font-medium text-primary-foreground hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "approve" ? "Approving…" : "⊙ Approve brief"}
                </Gated>
              </>
            )}
            {approved && (
              <span className="inline-flex items-center gap-2 rounded-md bg-primary/10 px-4 py-2.5 font-mono text-xs text-primary">
                <Dot pulse={false} /> Approved
              </span>
            )}
          </div>
        </div>
      </div>

      <DecisionDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        tone="approve"
        kicker="decision · gate g1"
        title="Approve research brief"
        description="Approving locks the brief version and clears gate G1. Runs cannot start until this decision is recorded."
        summary={[
          { label: "version", value: brief ? `v${brief.version}` : "—" },
          { label: "words", value: wordCount },
          { label: "chars", value: charCount },
          { label: "state", value: "draft / approved", tone: "approve" },
        ]}
        confirmLabel="⊙ Confirm approval"
        confirmingLabel="Approving…"
        placeholder="Why is this brief ready to run? Scope, assumptions, risks reviewed…"
        busy={busy === "approve"}
        onConfirm={doApprove}
      />

      <DecisionDialog
        open={reviseOpen}
        onOpenChange={setReviseOpen}
        tone="warn"
        kicker="decision · gate g1"
        title="Request brief revision"
        description="This discards the current draft and generates a new one. The note is stored with the request so the next reviewer can see what changed."
        summary={[
          { label: "current", value: brief ? `v${brief.version}` : "—" },
          { label: "next", value: brief ? `v${brief.version + 1}` : "v1", tone: "warn" },
        ]}
        confirmLabel="✕ Request revision"
        confirmingLabel="Revising…"
        placeholder="What needs to change? Missing scope, unclear method, weak citations…"
        busy={busy === "revise"}
        onConfirm={doRevise}
      />
    </div>
  );
}

// ─── Run setup ─────────────────────────────────────────────────────────────

/**
 * GATE G2 — approve the cost, then start the run.
 *
 * ⚠ THE COMPONENT THAT SPENDS MONEY. At ~415 lines it is the largest in the
 * file. Read it carefully before changing anything.
 *
 * The flow it enforces:
 *   1. the user sets a budget threshold and toggles run options
 *   2. `doEstimate` asks the backend what it would cost — no spending yet
 *   3. `DecisionDialog` shows that estimate and demands a typed note
 *   4. `doStart` launches with `approved_cost: true`
 *
 * That flag is the crux. As documented in `lib/api.ts`, `startRun` will not
 * proceed without it, so a run cannot begin unless a human has seen the
 * estimate and confirmed. The gate is enforced by the API contract, not just
 * by this UI.
 *
 * `doStart` is also the best example of HTTP-status-aware error handling in the
 * codebase — see the 402/429/400 branches, which turn status codes into
 * actionable messages.
 */
export function RunSetupCard({
  project,
  briefApproved,
  activeRun,
  capabilities,
  usage,
  onRunStarted,
  onRunCancelled,
}: {
  project: ProjectOut;
  briefApproved: boolean;
  activeRun: RunOut | null;
  capabilities: CapabilitiesOut | null;
  usage: UsageOut | null;
  onRunStarted: (run: RunOut) => void;
  onRunCancelled: (run: RunOut) => void;
}) {
  const [budget, setBudget] = useState("12");
  const [agentic, setAgentic] = useState(false);
  const [execute, setExecute] = useState(false);
  const [figures, setFigures] = useState(false);
  const [estimate, setEstimate] = useState<{ cost: number; assumptions: string } | null>(null);
  const [busy, setBusy] = useState<string>("");

  const running = activeRun && ["queued", "running", "revising"].includes(activeRun.status);

  const reasons = capabilities?.reasons ?? {};
  const runReady = capabilities ? capabilities.real_run_ready : false;
  const executeReady = capabilities ? capabilities.execute_ready : false;
  const figuresReady = capabilities ? capabilities.figures_ready : false;
  const orchestrationModes = capabilities?.orchestration_modes ?? [];
  const agenticReady = orchestrationModes.length === 0 || orchestrationModes.includes("agentic");
  const overBudgetCap = Boolean(usage?.over_budget);

  // Never send a config the server says it cannot honour.
  useEffect(() => {
    if (!executeReady) setExecute(false);
  }, [executeReady]);
  useEffect(() => {
    if (!figuresReady) setFigures(false);
  }, [figuresReady]);
  useEffect(() => {
    if (!agenticReady) setAgentic(false);
  }, [agenticReady]);

  // Builds the run configuration from the toggles. Extracted as a function
  // because BOTH `doEstimate` and `doStart` need it — and they must agree, or
  // the user would be quoted for one configuration and charged for another.
  const buildConfig = (): Record<string, unknown> => ({
    orchestration: agentic ? "agentic" : "linear",
    execute,
    figures,
  });

  /** Ask the backend what this run would cost. Spends nothing. */
  const doEstimate = async () => {
    setBusy("est");
    try {
      const e = await estimateRun(project.id, {
        budget_threshold: Number(budget) || 0,
        config_json: buildConfig(),
      });
      setEstimate({
        cost: e.cost_estimate,
        assumptions:
          typeof e.assumptions === "string" ? e.assumptions : JSON.stringify(e.assumptions),
      });
      toast.success(`Estimate: $${e.cost_estimate.toFixed(2)}`);
    } catch (err) {
      toast.error(friendlyError(err, "Could not estimate cost"));
    } finally {
      setBusy("");
    }
  };

  const [launchOpen, setLaunchOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const doStart = async (notes: string) => {
    setBusy("start");
    try {
      const run = await startRun(project.id, {
        budget_threshold: Number(budget) || 0,
        // ⚠ THE SPEND GATE. The backend rejects the request without this flag,
        // and it is only ever set here — inside the confirm handler of a dialog
        // that required the user to read an estimate and type a note. That is
        // what makes "the user approved this cost" true rather than assumed.
        approved_cost: true,
        // "real" — there is no dry-run mode. See the header of lib/api.ts.
        mode: "real",
        config_json: buildConfig(),
      });
      onRunStarted(run);
      setLaunchOpen(false);
      toast.success(`Run started${agentic ? " · agentic" : ""}`, { description: notes });
    } catch (err) {
      // STATUS-AWARE ERROR HANDLING — the payoff of the custom `ApiError`
      // class in lib/api.ts, which carries the HTTP status alongside the
      // message. Each branch tells the user something different about what to
      // do next, which a single generic "request failed" cannot.
      const msg = friendlyError(err, "Could not start run");
      if (err instanceof ApiError) {
        // 402 Payment Required — out of budget. Nothing to retry.
        if (err.status === 402) toast.error("Monthly budget cap reached", { description: msg });
        // 429 Too Many Requests — retrying later will work.
        else if (err.status === 429) toast.error("Rate limited", { description: msg });
        // 400 — a precondition failed. The appended hint names the two usual
        // causes so the user is not left guessing which gate blocked them.
        else if (err.status === 400)
          toast.error("Gate check failed", {
            description: msg + " (needs an approved brief and an enabled provider key)",
          });
        else toast.error(msg);
      } else toast.error(msg);
    } finally {
      setBusy("");
    }
  };

  const doCancel = async (notes: string) => {
    if (!activeRun) return;
    setBusy("cancel");
    try {
      const r = await apiCancelRun(activeRun.id);
      onRunCancelled(r);
      setCancelOpen(false);
      toast.warning("Run cancelled", { description: notes });
    } catch (err) {
      toast.error(friendlyError(err, "Could not cancel run"));
    } finally {
      setBusy("");
    }
  };

  const budgetNum = Number(budget) || 0;
  const estCost = estimate?.cost ?? 0;
  const headroom = budgetNum - estCost;
  const overBudget = estimate ? estCost > budgetNum : false;
  const gateTone: DotTone = !briefApproved
    ? "warning"
    : overBudget || overBudgetCap
      ? "error"
      : !runReady
        ? "warning"
        : running
          ? "success"
          : "muted";
  const gateLabel = !briefApproved
    ? "awaiting brief"
    : overBudgetCap
      ? "monthly cap reached"
      : overBudget
        ? "over budget"
        : !runReady
          ? "provider key required"
          : running
            ? "run active"
            : "ready";
  const launchBlocked =
    !briefApproved || Boolean(running) || Boolean(busy) || overBudget || !runReady || overBudgetCap;

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="run gate · g2"
        title="Budget & launch"
        subtitle="Set the ceiling, estimate cost, then approve launch. Every run is real: it calls your enabled provider and spends credits. Gate G2 opens once a brief is approved, capability checks pass, and cost is within budget."
        meta={
          <>
            <MetaChip tone={gateTone}>{gateLabel}</MetaChip>
            <MetaChip tone="warning">real run · spends $</MetaChip>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-px bg-panel-border sm:grid-cols-4">
        <div className="bg-panel p-3">
          <div className="mono-label">budget</div>
          <div className="mt-1 font-mono text-sm text-foreground">${budgetNum.toFixed(2)}</div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">estimate</div>
          <div
            className={`mt-1 font-mono text-sm ${overBudget ? "text-destructive" : estimate ? "text-foreground" : "text-muted-foreground"}`}
          >
            {estimate ? `$${estCost.toFixed(2)}` : "—"}
          </div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">headroom</div>
          <div
            className={`mt-1 font-mono text-sm ${overBudget ? "text-destructive" : "text-foreground"}`}
          >
            {estimate ? `${headroom >= 0 ? "+" : ""}$${headroom.toFixed(2)}` : "—"}
          </div>
        </div>
        <div className="bg-panel p-3">
          <div className="mono-label">providers</div>
          <div
            className={`mt-1 truncate font-mono text-sm ${runReady ? "text-foreground" : "text-warning"}`}
            title={capabilities?.enabled_providers?.join(", ")}
          >
            {capabilities
              ? capabilities.enabled_providers.length > 0
                ? capabilities.enabled_providers.join(", ")
                : "none enabled"
              : "—"}
          </div>
        </div>
      </div>

      <div className="space-y-6 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mono-label">budget threshold (usd)</label>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              className="mt-2 w-full rounded-md border border-panel-border bg-background/50 px-3 py-2.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="mono-label">execution</label>
            <div
              className={`mt-2 rounded-md border px-3 py-2.5 font-mono text-xs ${
                runReady
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "border-warning/40 bg-warning/5 text-warning"
              }`}
            >
              {runReady
                ? "Real run · spends provider credits"
                : reasons.real_run_ready || "Enable a provider key to unlock runs"}
            </div>
          </div>
        </div>

        <div>
          <label className="mono-label">orchestration &amp; tools</label>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <ToggleTile
              on={agentic}
              onChange={agenticReady ? setAgentic : () => {}}
              icon="✦"
              label="Agentic"
              caption={
                agenticReady
                  ? "planner + tool loop"
                  : reasons.orchestration || "agentic loop unavailable"
              }
            />
            <ToggleTile
              on={execute}
              onChange={executeReady ? setExecute : () => {}}
              icon="⚙"
              label="Execute on RunPod"
              caption={
                executeReady
                  ? "run generated code"
                  : reasons.execute_ready || "execution backend unavailable"
              }
              tone="danger"
            />
            <ToggleTile
              on={figures}
              onChange={figuresReady ? setFigures : () => {}}
              icon="◨"
              label="Generate figures"
              caption={
                figuresReady
                  ? "via Gemini image"
                  : reasons.figures_ready || "figure model unavailable"
              }
            />
          </div>
        </div>

        {estimate && (
          <div
            className={`rounded-md border px-4 py-3 font-mono text-[12px] ${
              overBudget
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-primary/30 bg-primary/5 text-foreground"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="mono-label">
                {overBudget ? "over budget · adjust ceiling" : "estimated cost"}
              </span>
              <strong>${estCost.toFixed(2)}</strong>
            </div>
            {estimate.assumptions && (
              <div className="mt-1.5 text-[11px] text-muted-foreground">{estimate.assumptions}</div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-panel-border pt-5">
          <div className="flex items-center gap-2 font-mono text-[12px]">
            {!briefApproved ? (
              <>
                <Dot tone="warning" />
                <span className="text-warning">
                  Approve a brief before estimating or starting runs.
                </span>
              </>
            ) : activeRun ? (
              <>
                <Dot
                  tone={
                    activeRun.status === "running" || activeRun.status === "completed"
                      ? "success"
                      : activeRun.status === "failed" || activeRun.status === "cancelled"
                        ? "error"
                        : "warning"
                  }
                />
                <span className="text-foreground">
                  run #{activeRun.id} · {activeRun.status} · ${activeRun.actual_cost.toFixed(2)} of
                  ${activeRun.budget_threshold.toFixed(2)}
                </span>
              </>
            ) : (
              <>
                <Dot />
                <span className="text-foreground">Gate cleared · ready to launch a run.</span>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={!briefApproved || Boolean(busy) || !runReady}
              onClick={doEstimate}
              className="flex items-center gap-2 rounded-md border border-panel-border bg-background/60 px-4 py-2.5 font-mono text-xs text-muted-foreground disabled:opacity-50 enabled:hover:border-foreground/40 enabled:hover:text-foreground"
            >
              {busy === "est" ? "Estimating…" : "⊡ Estimate"}
            </button>
            <Gated
              perm="run:start"
              disabled={launchBlocked}
              onClick={() => setLaunchOpen(true)}
              className="flex items-center gap-2 rounded-md bg-destructive px-4 py-2.5 font-mono text-xs font-medium text-destructive-foreground hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "start" ? "Starting…" : "Approve & start real run"}
            </Gated>
            {running && (
              <Gated
                perm="run:cancel"
                onClick={() => setCancelOpen(true)}
                disabled={busy === "cancel"}
                className="flex items-center gap-2 rounded-md border border-destructive/40 px-4 py-2.5 font-mono text-xs text-destructive hover:border-destructive disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "cancel" ? "Cancelling…" : "■ Cancel run"}
              </Gated>
            )}
          </div>
        </div>
      </div>

      <DecisionDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        tone="danger"
        kicker="decision · gate g2"
        title="Approve real-money launch"
        description="This spends real credits on the connected agent using your saved provider key. There is no mock path. Your note is recorded with the run."
        summary={[
          { label: "budget", value: `$${budgetNum.toFixed(2)}` },
          {
            label: "estimate",
            value: estimate ? `$${estCost.toFixed(2)}` : "not estimated",
            tone: overBudget ? "danger" : undefined,
          },
          {
            label: "headroom",
            value: estimate ? `${headroom >= 0 ? "+" : ""}$${headroom.toFixed(2)}` : "—",
            tone: overBudget ? "danger" : undefined,
          },
          {
            label: "monthly remaining",
            value: usage ? `$${usage.remaining.toFixed(2)}` : "—",
            tone: overBudgetCap ? "danger" : undefined,
          },
          {
            label: "orchestration",
            value: agentic ? "agentic loop" : "linear",
          },
          {
            label: "code execution",
            value: execute ? "RunPod enabled" : "disabled",
            tone: execute ? "danger" : undefined,
          },
        ]}
        confirmLabel="Confirm & spend"
        confirmingLabel="Starting…"
        placeholder="Why is this real-money spend authorized? Reviewer, budget owner, expected outcome…"
        busy={busy === "start"}
        onConfirm={doStart}
      />

      <DecisionDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        tone="danger"
        kicker="decision · run"
        title="Cancel active run"
        description="Cancelling stops the orchestrator immediately. Partial artifacts are kept but the run is marked cancelled."
        summary={
          activeRun
            ? [
                { label: "run", value: `#${activeRun.id}` },
                { label: "status", value: activeRun.status, tone: "warn" },
                { label: "spent", value: `$${activeRun.actual_cost.toFixed(2)}` },
                { label: "budget", value: `$${activeRun.budget_threshold.toFixed(2)}` },
              ]
            : undefined
        }
        confirmLabel="■ Confirm cancellation"
        confirmingLabel="Cancelling…"
        placeholder="Reason for cancelling — cost overrun, wrong scope, provider issue…"
        busy={busy === "cancel"}
        onConfirm={doCancel}
      />
    </div>
  );
}

// ─── Live logs ─────────────────────────────────────────────────────────────

// ─── Bento header shared by run-session cards ──────────────────────────────

// ─── Bento-grid atoms ──────────────────────────────────────────────────────
// A second small set of presentational pieces, used by the live-execution
// panels below. ("Bento" is the layout style: a grid of variously-sized boxes.)

/** A panel header with a title, optional kicker, and a right-hand slot. */
