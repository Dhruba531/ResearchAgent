// Gate G4 — approve publication. `GroundednessList` surfaces dead links,
// placeholders, and fabricated citations found in the draft.

import { useState } from "react";
import { toast } from "sonner";
import {
  approveFinal,
  ApiError,
  type ProjectOut,
  type RunOut,
  type GroundednessReport,
} from "@/lib/api";
import { BentoHead, Dot, DotTone, MetaChip, friendlyError } from "./primitives";
import { Gated } from "./gating";
import { DecisionDialog } from "./gates";
import { PROVIDERS } from "./settings";

export function FinalExport({
  project,
  runComplete,
  hasFindings,
  activeRun,
  onExported,
}: {
  project: ProjectOut;
  runComplete: boolean;
  hasFindings: boolean;
  activeRun: RunOut | null;
  onExported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [grounding, setGrounding] = useState<GroundednessReport | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);

  // Both preconditions: the run must have finished AND produced review
  // findings. A completed run with no findings means the review step did not
  // run, so there is nothing to have approved.
  const ready = runComplete && hasFindings;
  const groundScore =
    grounding?.score !== undefined ? `${(grounding.score * 100).toFixed(1)}%` : "—";
  const groundIssues =
    (grounding?.dead_urls?.length ?? 0) +
    (grounding?.placeholders?.length ?? 0) +
    (grounding?.fabrications?.length ?? 0);

  const gateTone: DotTone = done ? "success" : grounding ? "warning" : ready ? "info" : "muted";
  const gateLabel = done
    ? "G3 · APPROVED"
    : grounding
      ? "G3 · BLOCKED"
      : ready
        ? "G3 · READY FOR REVIEW"
        : "G3 · LOCKED";

  const extractReport = (body: unknown): GroundednessReport | null => {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    const src =
      (b.detail && typeof b.detail === "object" ? (b.detail as Record<string, unknown>) : null) ??
      (b.groundedness && typeof b.groundedness === "object"
        ? (b.groundedness as Record<string, unknown>)
        : null) ??
      b;
    return {
      score: typeof src.score === "number" ? src.score : undefined,
      dead_urls: Array.isArray(src.dead_urls) ? (src.dead_urls as string[]) : undefined,
      placeholders: Array.isArray(src.placeholders) ? (src.placeholders as string[]) : undefined,
      fabrications: Array.isArray(src.fabrications) ? (src.fabrications as string[]) : undefined,
    };
  };

  const doExport = async (notes: string, force: boolean) => {
    setBusy(true);
    try {
      await approveFinal(project.id, { notes, force });
      setDone(true);
      setGrounding(null);
      setApproveOpen(false);
      setForceOpen(false);
      onExported();
      toast.success(
        force
          ? "Package force-exported · gate G3 bypassed"
          : "Package signed and exported · gate G3 cleared",
        { description: notes.length > 60 ? `${notes.slice(0, 60)}…` : notes },
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const rep = extractReport(e.body);
        setGrounding(rep ?? { score: undefined });
        setApproveOpen(false);
        toast.warning("Groundedness gate blocked export", {
          description: "Review issues below, then use Force export if you accept them.",
        });
      } else {
        toast.error(friendlyError(e, "Could not approve export"));
      }
    } finally {
      setBusy(false);
    }
  };

  const checklist = [
    { ok: runComplete, label: "run completed", detail: activeRun ? activeRun.status : "no run" },
    {
      ok: hasFindings,
      label: "reviewer findings recorded",
      detail: hasFindings ? "present" : "run reviewer panel",
    },
    {
      ok: !grounding || done,
      label: "groundedness gate",
      detail: grounding ? `${groundIssues} issues` : "not yet run",
    },
  ];

  return (
    <div className="panel overflow-hidden">
      <BentoHead
        kicker="approval · gate g3"
        title={
          done
            ? "Final package signed and exported."
            : grounding
              ? "Groundedness check failed — resolve or force."
              : ready
                ? "Final package awaits human approval."
                : "Final export is locked."
        }
        subtitle="Every download and hand-off is blocked until this gate is approved. Notes are recorded to the audit trail."
        meta={
          <>
            <MetaChip tone={gateTone}>{gateLabel}</MetaChip>
            <MetaChip tone={runComplete ? "success" : "muted"}>
              run · {activeRun ? activeRun.status : "none"}
            </MetaChip>
            <MetaChip tone={hasFindings ? "success" : "warning"}>
              findings · {hasFindings ? "yes" : "missing"}
            </MetaChip>
            {grounding && <MetaChip tone="warning">groundedness · {groundIssues} issues</MetaChip>}
          </>
        }
      />

      <div className="grid grid-cols-4 gap-px bg-panel-border">
        <div className="bg-panel p-4">
          <div className="mono-label">gate</div>
          <div className="mt-1 font-mono text-[13px] text-foreground">G3 · export</div>
        </div>
        <div className="bg-panel p-4">
          <div className="mono-label">project</div>
          <div className="mt-1 font-mono text-[13px] text-foreground">#{project.id}</div>
        </div>
        <div className="bg-panel p-4">
          <div className="mono-label">groundedness</div>
          <div
            className={`mt-1 font-mono text-[13px] ${
              grounding ? "text-warning" : "text-foreground"
            }`}
          >
            {groundScore}
          </div>
        </div>
        <div className="bg-panel p-4">
          <div className="mono-label">status</div>
          <div
            className={`mt-1 font-mono text-[13px] ${
              done ? "text-success" : ready ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {done ? "approved" : ready ? "awaiting" : "locked"}
          </div>
        </div>
      </div>

      <div className="grid gap-6 p-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="mono-label mb-3">pre-flight checklist</div>
          <ul className="space-y-2">
            {checklist.map((c) => (
              <li
                key={c.label}
                className="flex items-center justify-between rounded-md border border-panel-border bg-background/40 px-3 py-2 font-mono text-[12px]"
              >
                <span className="flex items-center gap-2">
                  <Dot tone={c.ok ? "success" : "warning"} pulse={false} />
                  <span className="text-foreground">{c.label}</span>
                </span>
                <span className="text-muted-foreground">{c.detail}</span>
              </li>
            ))}
          </ul>
          {!ready && !done && (
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              Complete the run and the reviewer panel to unlock the approval dialog.
            </p>
          )}
        </div>

        <div className="flex flex-col justify-between gap-4 rounded-md border border-panel-border bg-background/40 p-4">
          <div>
            <div className="mono-label">decision</div>
            <p className="mt-2 font-serif text-lg leading-snug text-foreground">
              {done
                ? "Exports are unlocked. Reviewers can download the signed package."
                : grounding
                  ? "Groundedness gate raised issues. Approving now requires a Force export note."
                  : ready
                    ? "Approve to sign the package and unlock artifact downloads."
                    : "Approval is disabled until the checklist above is green."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Gated
              perm="final:approve"
              type="button"
              disabled={!ready || busy || done || Boolean(grounding)}
              onClick={() => setApproveOpen(true)}
              className="rounded-md bg-primary px-4 py-2.5 font-mono text-xs font-medium text-primary-foreground hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {done ? "✓ Approved" : busy ? "Approving…" : "⬒ Approve & export"}
            </Gated>
            <Gated
              perm="final:force"
              type="button"
              disabled={busy || done || !ready}
              onClick={() => setForceOpen(true)}
              className="rounded-md border border-destructive/40 px-4 py-2.5 font-mono text-xs text-destructive hover:border-destructive disabled:cursor-not-allowed disabled:opacity-50"
            >
              Force export
            </Gated>
          </div>
        </div>
      </div>

      {grounding && (
        <div className="mx-6 mb-6 rounded-md border border-warning/50 bg-warning/5 p-4 font-mono text-[12px] text-foreground">
          <div className="flex items-center justify-between border-b border-warning/30 pb-2">
            <span className="mono-label">GROUNDEDNESS REPORT</span>
            {grounding.score !== undefined && (
              <span>
                score: <strong>{(grounding.score * 100).toFixed(1)}%</strong>
              </span>
            )}
          </div>
          <GroundednessList label="dead URLs" items={grounding.dead_urls} tone="error" />
          <GroundednessList
            label="unresolved placeholders"
            items={grounding.placeholders}
            tone="warning"
          />
          <GroundednessList
            label="suspected fabrications"
            items={grounding.fabrications}
            tone="error"
          />
        </div>
      )}

      <DecisionDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        tone="approve"
        kicker="decision · gate g3"
        title="Approve final export"
        description="Signs the package and unlocks artifact downloads for reviewers. Your note becomes part of the audit trail."
        summary={[
          { label: "project", value: `#${project.id}` },
          { label: "run", value: activeRun ? `#${activeRun.id} · ${activeRun.status}` : "—" },
          {
            label: "actual cost",
            value: activeRun ? `$${activeRun.actual_cost.toFixed(2)}` : "—",
          },
          { label: "findings", value: hasFindings ? "recorded" : "missing" },
        ]}
        confirmLabel="⬒ Sign & export"
        confirmingLabel="Approving…"
        placeholder="What was validated? Reviewer, scope, follow-ups…"
        busy={busy}
        onConfirm={(notes) => doExport(notes, false)}
      />

      <DecisionDialog
        open={forceOpen}
        onOpenChange={setForceOpen}
        tone="danger"
        kicker="decision · gate g3 bypass"
        title="Force export (bypass groundedness gate)"
        description="Exports the package even though groundedness checks failed. Only proceed if you have manually verified the issues are acceptable."
        summary={[
          { label: "project", value: `#${project.id}` },
          {
            label: "groundedness",
            value: grounding?.score !== undefined ? groundScore : "not run",
            tone: "danger",
          },
          {
            label: "issues",
            value: grounding ? `${groundIssues}` : "unknown",
            tone: "danger",
          },
          { label: "gate", value: "G3 bypass", tone: "danger" },
        ]}
        confirmLabel="Force sign & export"
        confirmingLabel="Bypassing…"
        minChars={20}
        placeholder="Explain why bypass is acceptable — verified sources, accepted risks, sign-off…"
        busy={busy}
        onConfirm={(notes) => doExport(notes, true)}
      />
    </div>
  );
}

/**
 * Renders one category of groundedness problem — dead URLs, leftover
 * placeholders, or suspected fabrications.
 *
 * Returns null when the list is empty, so a clean report shows nothing at all
 * rather than three empty headings.
 */
export function GroundednessList({
  label,
  items,
  tone,
}: {
  label: string;
  items?: string[];
  tone: DotTone;
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Dot tone={tone} pulse={false} /> {label} ({items.length})
      </div>
      <ul className="mt-1 space-y-1 pl-4">
        {items.map((s, i) => (
          <li key={i} className="break-all text-foreground/90">
            • {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Provider keys ─────────────────────────────────────────────────────────

/**
 * Describes one LLM provider for the settings panel: its display strings, its
 * model options, and the helper text explaining where to get a key.
 *
 * Driving the UI from this array means adding a provider is appending an object
 * to `PROVIDERS` below rather than writing another block of form markup — the
 * same content-as-data approach as `RELEASES` in changelog.tsx.
 */
