// Gate G3 — request targeted edits to the paper before final export.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  estimateRevision,
  previewRevision,
  listRevisions,
  applyRevision,
  type RunOut,
  type RevisionOut,
} from "@/lib/api";
import { BentoHead, MetaChip, StatusBadge, friendlyError } from "./primitives";
import { Gated } from "./gating";
import { DecisionDialog } from "./gates";

export function RevisionGate({
  run,
  onRunUpdated,
}: {
  run: RunOut | null;
  onRunUpdated: (r: RunOut) => void;
}) {
  const [excerpt, setExcerpt] = useState("");
  const [instruction, setInstruction] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [preview, setPreview] = useState<RevisionOut | null>(null);
  const [history, setHistory] = useState<RevisionOut[]>([]);
  const [busy, setBusy] = useState<null | "estimate" | "preview" | "apply">(null);
  const [applyOpen, setApplyOpen] = useState(false);

  const runId = run?.id ?? null;
  const draft = run?.draft_markdown ?? "";
  const eligible = Boolean(run && ["review", "completed", "revising"].includes(run.status));

  useEffect(() => {
    setExcerpt("");
    setInstruction("");
    setEstimate(null);
    setPreview(null);
    setHistory([]);
    if (runId == null) return;
    listRevisions(runId)
      .then(setHistory)
      .catch(() => {
        /* backend may not expose history yet */
      });
  }, [runId]);

  const captureSelection = () => {
    const sel = typeof window !== "undefined" ? window.getSelection()?.toString().trim() : "";
    if (!sel) {
      toast.error("Select text inside the draft first.");
      return;
    }
    setExcerpt(sel);
    setPreview(null);
    setEstimate(null);
    toast.success(`Target captured · ${sel.length} chars`);
  };

  const doEstimate = async () => {
    if (runId == null) return;
    setBusy("estimate");
    try {
      const res = await estimateRevision(runId, { instruction, target_excerpt: excerpt });
      setEstimate(res.cost_estimate);
      toast.success(`Revision estimate · $${res.cost_estimate.toFixed(2)}`);
    } catch (e) {
      toast.error(friendlyError(e, "Could not estimate revision"));
    } finally {
      setBusy(null);
    }
  };

  const doPreview = async () => {
    if (runId == null) return;
    setBusy("preview");
    try {
      const rev = await previewRevision(runId, { instruction, target_excerpt: excerpt });
      setPreview(rev);
      toast.success("Replacement drafted — review before applying.");
    } catch (e) {
      toast.error(friendlyError(e, "Could not draft revision"));
    } finally {
      setBusy(null);
    }
  };

  const doApply = async (notes: string) => {
    if (runId == null || !preview) return;
    setBusy("apply");
    try {
      const updated = await applyRevision(runId, preview.id, notes);
      onRunUpdated(updated);
      setApplyOpen(false);
      setPreview(null);
      setEstimate(null);
      setExcerpt("");
      setInstruction("");
      const list = await listRevisions(runId).catch(() => [] as RevisionOut[]);
      setHistory(list);
      toast.success("Revision applied to the paper draft.");
    } catch (e) {
      toast.error(friendlyError(e, "Could not apply revision"));
    } finally {
      setBusy(null);
    }
  };

  const ready = excerpt.trim().length > 20 && instruction.trim().length > 8;

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="human gate · g3"
        title="Targeted paper revision"
        subtitle="Select a passage in the draft, describe the fix, preview the replacement with its cost, then approve the apply. Scoped edits only — this never regenerates the whole paper."
        meta={
          <>
            <MetaChip tone={eligible ? "success" : "muted"}>
              {eligible ? "gate open" : "awaiting run output"}
            </MetaChip>
            {history.length > 0 && <MetaChip>{history.length} revisions</MetaChip>}
          </>
        }
      />

      <div className="space-y-4 p-5">
        {!eligible ? (
          <p className="text-[13px] text-muted-foreground">
            Revisions unlock once a run reaches <span className="font-mono">review</span> or{" "}
            <span className="font-mono">completed</span> and a draft exists.
          </p>
        ) : (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="mono-label">1 · target passage</label>
                <button
                  type="button"
                  onClick={captureSelection}
                  className="rounded-md border border-panel-border px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  use draft selection
                </button>
              </div>
              <textarea
                value={excerpt}
                onChange={(e) => {
                  setExcerpt(e.target.value);
                  setPreview(null);
                }}
                rows={4}
                placeholder="Paste (or select above) the exact passage to replace…"
                className="w-full resize-y rounded-md border border-panel-border bg-background/50 p-3 font-mono text-[12px] leading-relaxed text-foreground outline-none focus:border-primary/60"
              />
              {excerpt && draft && !draft.includes(excerpt.trim()) && (
                <p className="mt-1 font-mono text-[10.5px] text-warning">
                  passage not found verbatim in the current draft
                </p>
              )}
            </div>

            <div>
              <label className="mono-label">2 · instruction</label>
              <textarea
                value={instruction}
                onChange={(e) => {
                  setInstruction(e.target.value);
                  setPreview(null);
                }}
                rows={3}
                placeholder="e.g. Replace the unsupported claim with a hedged statement and cite the 2024 benchmark table."
                className="mt-2 w-full resize-y rounded-md border border-panel-border bg-background/50 p-3 text-[13px] leading-relaxed text-foreground outline-none focus:border-primary/60"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Gated
                perm="run:start"
                disabled={!ready || Boolean(busy)}
                onClick={doEstimate}
                className="rounded-md border border-panel-border px-3.5 py-2 font-mono text-xs text-foreground hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "estimate" ? "Estimating…" : "Estimate cost"}
              </Gated>
              <Gated
                perm="run:start"
                disabled={!ready || Boolean(busy)}
                onClick={doPreview}
                className="rounded-md bg-primary px-3.5 py-2 font-mono text-xs font-medium text-primary-foreground hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "preview" ? "Drafting…" : "Preview replacement"}
              </Gated>
              {estimate != null && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  est. ${estimate.toFixed(2)}
                </span>
              )}
            </div>

            {preview && (
              <div className="rounded-md border border-panel-border bg-background/40 p-4">
                <div className="mono-label">3 · proposed replacement</div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div>
                    <div className="mono-label text-destructive">removing</div>
                    <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded border border-destructive/25 bg-destructive/5 p-3 font-mono text-[11.5px] leading-relaxed text-foreground">
                      {preview.target_excerpt || excerpt}
                    </pre>
                  </div>
                  <div>
                    <div className="mono-label text-success">inserting</div>
                    <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded border border-panel-border bg-panel p-3 font-mono text-[11.5px] leading-relaxed text-foreground">
                      {preview.replacement_markdown}
                    </pre>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Gated
                    perm="run:start"
                    disabled={Boolean(busy)}
                    onClick={() => setApplyOpen(true)}
                    className="rounded-md bg-success px-3.5 py-2 font-mono text-xs font-medium text-background hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Approve & apply
                  </Gated>
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    className="rounded-md border border-panel-border px-3 py-2 font-mono text-xs text-muted-foreground hover:text-foreground"
                  >
                    Discard preview
                  </button>
                  {preview.cost_estimate != null && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      cost ${preview.cost_estimate.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {history.length > 0 && (
              <div>
                <div className="mono-label">applied history</div>
                <ul className="mt-2 space-y-1.5">
                  {history.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-start gap-3 rounded-md border border-panel-border bg-background/40 px-3 py-2"
                    >
                      <span className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                        #{r.id}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                        {r.instruction}
                      </span>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <DecisionDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        tone="approve"
        kicker="decision · gate g3"
        title="Apply revision to the paper"
        description="This rewrites the selected passage in the run's draft. The prior text is kept in the revision history for audit."
        summary={[
          { label: "run", value: run ? `#${run.id}` : "—" },
          { label: "revision", value: preview ? `#${preview.id}` : "—" },
          {
            label: "cost",
            value:
              preview?.cost_estimate != null
                ? `$${preview.cost_estimate.toFixed(2)}`
                : estimate != null
                  ? `$${estimate.toFixed(2)}`
                  : "—",
          },
          { label: "scope", value: `${excerpt.trim().length} chars replaced` },
        ]}
        confirmLabel="Confirm & apply"
        confirmingLabel="Applying…"
        placeholder="Why is this edit correct? Reviewer, source, finding it resolves…"
        busy={busy === "apply"}
        onConfirm={doApply}
      />
    </div>
  );
}

// ===========================================================================
//  ⭐ THE ENTRY POINT — start here. Everything above is a piece this assembles.
// ===========================================================================
//
//  This component owns ALL the shared state for the console and passes it down.
//  That is why it is long: the ~15 `useState` calls below are the page's single
//  source of truth, and the components above are largely presentational.
//
//  Its five effects, in order:
//    1. auth gate         — verify the session, bounce to /auth if absent
//    2. load projects     — once authenticated
//    3. capabilities+usage — polled every 60s, drives gating across the page
//    4. load active project — whenever the selected project changes
//    5. live logs         — WebSocket subscription with a polling fallback
//
//  Effect 5 is the most intricate code in the file; it is commented in detail.
