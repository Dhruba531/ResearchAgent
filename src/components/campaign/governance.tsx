// Governance. Audit status per candidate plus the
// human-in-the-loop promote / reject gate, behind a confirmation dialog.
//
// The first component in this folder that WRITES data rather than only
// displaying it, which makes it the one to read for these patterns:
//   • async mutations with loading state and error handling
//   • a confirmation dialog before an irreversible action
//   • toast notifications for success and failure
//   • lifting results to the parent via an `onUpdated` callback
//
// The domain purpose: an automated search that finds a suspiciously large
// improvement has usually exploited a bug — leaked test data, a broken metric —
// rather than made a genuine discovery. This panel is the human checkpoint that
// stops such a candidate entering the frontier and being used as a parent for
// further search, which would compound the error.

import { useState } from "react";
import { Check, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getAuditReport,
  promoteCandidate,
  rejectCandidate,
  type AuditReportOut,
  type CandidateOut,
} from "@/lib/api";
import { Chip, Panel, PanelHead } from "./primitives";

export function GovernancePanel({
  candidate,
  // A CALLBACK PROP — how a child sends data back up. This component cannot
  // update the parent's state directly, so after a successful mutation it calls
  // `onUpdated(newCandidate)` and lets the parent decide what to do. Data flows
  // down through props, changes flow up through callbacks.
  onUpdated,
}: {
  candidate: CandidateOut;
  onUpdated: (c: CandidateOut) => void;
}) {
  // Five pieces of state. Note each has one clear job — resisting the urge to
  // merge them into a single object keeps updates independent.
  //
  // `mode` does double duty: it records WHICH action is pending and, by being
  // non-null, whether the dialog is open at all (see the <Dialog> below). One
  // value, no chance of "dialog open but no action selected".
  const [mode, setMode] = useState<"promote" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); // a mutation is in flight
  const [report, setReport] = useState<AuditReportOut | null>(null);
  const [loadingReport, setLoadingReport] = useState(false); // the report is loading

  // Two separate loading flags rather than one, because the two operations are
  // independent — refreshing the report should not disable the Promote button.

  // Prefer the freshly-fetched report, fall back to the audit embedded in the
  // candidate prop, then to null. This `??` chain is what lets the panel render
  // immediately from prop data and silently upgrade once a newer report loads.
  const audit = report?.audit ?? candidate.audit ?? null;
  // A decided candidate cannot be decided again — this disables both buttons.
  const decided = audit?.decision === "promoted" || audit?.decision === "rejected";

  /** Fetch the full audit report on demand. */
  const loadReport = async () => {
    setLoadingReport(true);
    try {
      setReport(await getAuditReport(candidate.id));
    } catch (e) {
      // `e instanceof Error ? e.message : fallback` — the standard defensive
      // read of a caught value, since JavaScript allows throwing non-Errors.
      toast.error(e instanceof Error ? e.message : "Audit report unavailable");
    } finally {
      // `finally` guarantees the flag is cleared on BOTH paths. Putting this in
      // the `try` would leave the button spinning forever after an error — a
      // very common bug.
      setLoadingReport(false);
    }
  };

  /** Execute the pending promote or reject. */
  const confirm = async () => {
    setBusy(true);
    try {
      const updated =
        mode === "promote"
          ? await promoteCandidate(candidate.id, reason)
          : await rejectCandidate(candidate.id, reason);
      // Hand the server's updated record to the parent, so the whole page
      // reflects the change without a refetch.
      onUpdated(updated);
      toast.success(mode === "promote" ? "Promoted to frontier" : "Candidate rejected");
      // Reset local state only on SUCCESS. Note these lines sit inside the
      // `try`, after the await — so if the request fails, the dialog stays open
      // with the user's typed reason intact and they can retry rather than
      // losing their work.
      setMode(null);
      setReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  // The check list: use the server's checks when a report has loaded, otherwise
  // synthesise an equivalent list from the candidate's embedded audit fields.
  // The fallback is what lets the panel show meaningful checks before (or
  // without) fetching the full report.
  //
  // `Boolean(...)` coerces a possibly-undefined field to a real true/false, so
  // "field missing" renders as a failed check rather than as `undefined`.
  const checks = report?.checks ?? [
    // Does the evaluation hash match? A mismatch means the candidate was scored
    // against something other than the declared evaluation.
    { name: "eval hash match", ok: Boolean(audit?.eval_hash_match) },
    // Did test data leak into training? The check that catches the most common
    // way an automated search produces a fraudulently good score.
    { name: "leakage scan", ok: audit?.leakage_scan === "clean" },
    { name: "budget compliance", ok: Boolean(audit?.budget_compliant) },
  ];

  return (
    <Panel>
      <PanelHead
        kicker="safety · governance"
        title="Audit & promotion gate"
        subtitle="Large or suspicious improvements do not enter the frontier until a human signs off on the audit."
        meta={
          // A nested ternary: warning while pending, then green or red once
          // decided. Readable at this depth; anything more would want a helper.
          <Chip tone={decided ? (audit?.decision === "promoted" ? "success" : "danger") : "warning"}>
            {audit?.decision ?? "pending"}
          </Chip>
        }
      />

      {/* `space-y-2` applies a top margin to every child except the first —
          a neat way to space a list without margins on the items themselves. */}
      <div className="space-y-2 px-6 py-5">
        {checks.map((c) => (
          <div
            key={c.name}
            className="flex items-center justify-between rounded-md border border-panel-border bg-background/40 px-3 py-2"
          >
            <span className="font-mono text-[12px] text-muted-foreground">{c.name}</span>
            <span
              className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${c.ok ? "text-success" : "text-destructive"}`}
            >
              {/* Icon AND colour AND text all encode pass/fail. Redundant on
                  purpose: colour alone excludes colour-blind users. */}
              {c.ok ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              {/* "review" rather than "fail" — a failed check is a prompt for a
                  human to look, not a verdict. */}
              {c.ok ? "pass" : "review"}
              {/* `"detail" in c` is a TYPE GUARD. `checks` is a union of the
                  server shape (which has `detail`) and the synthesised fallback
                  (which does not), so TypeScript will not allow `c.detail`
                  unguarded. The `in` operator narrows the union at runtime and
                  at compile time simultaneously. */}
              {"detail" in c && c.detail ? <span className="text-muted-foreground"> · {c.detail}</span> : null}
            </span>
          </div>
        ))}
        {audit?.reason && (
          <p className="pt-1 text-[12px] text-muted-foreground">Reviewer note: {audit.reason}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-panel-border px-6 py-4">
        <Button size="sm" variant="ghost" onClick={loadReport} disabled={loadingReport}>
          {/* A spinner that appears only while loading. `animate-spin` is
              Tailwind's built-in rotation. Disabling the button at the same
              time prevents duplicate requests from impatient double-clicks. */}
          {loadingReport && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Refresh audit report
        </Button>
        <div className="flex gap-2">
          {/* These buttons do NOT act directly — they set `mode`, which opens
              the confirmation dialog. Both are irreversible and recorded in the
              ledger, so they are worth a deliberate second step. */}
          <Button size="sm" onClick={() => setMode("promote")} disabled={decided}>
            <Check className="h-3.5 w-3.5" /> Promote to frontier
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("reject")} disabled={decided}>
            <X className="h-3.5 w-3.5" /> Reject
          </Button>
        </div>
      </div>

      {/* THE CONFIRMATION DIALOG (Radix, via shadcn/ui).
          `open` derives from `mode` — no separate boolean to keep in sync.
          `onOpenChange` fires when Radix wants to close (Escape, clicking
          outside), and `!o && setMode(null)` closes only on those events,
          ignoring the open transition. Radix handles focus trapping and
          restoration, so keyboard users are not stranded behind the dialog. */}
      <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === "promote" ? "Promote candidate" : "Reject candidate"} c{candidate.id}
            </DialogTitle>
            {/* Spells out the CONSEQUENCE, not just the action. "makes it
                eligible as a search parent" is the part a user needs, because
                it means the decision affects every future candidate too. */}
            <DialogDescription>
              {mode === "promote"
                ? "Promotion marks this candidate as an accepted frontier point and makes it eligible as a search parent."
                : "Rejection removes the candidate from the frontier and records the reason in the ledger."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            // The placeholder states the requirement, which the disabled
            // Confirm button below then enforces.
            placeholder={mode === "promote" ? "Sign-off note (optional)" : "Reason for rejection (required)"}
            className="min-h-[96px] font-mono text-[13px]"
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={confirm}
              // Two independent reasons to disable: a request is in flight, or
              // a rejection has no reason. `.trim()` means whitespace does not
              // satisfy the requirement.
              //
              // The asymmetry is intentional — approving needs no justification,
              // but rejecting does, so the ledger records why a candidate was
              // thrown out.
              disabled={busy || (mode === "reject" && reason.trim().length === 0)}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Confirm {mode}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
