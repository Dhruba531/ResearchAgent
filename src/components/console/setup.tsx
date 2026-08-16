// Pre-run setup — pointing the app at a backend, and capturing the research
// question that seeds everything downstream.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  clearApiBase,
  getApiBase,
  hasRealBackend,
  health,
  saveIdea,
  setApiBase,
  type ProjectOut,
} from "@/lib/api";
import { Dot, SectionHeader, friendlyError } from "./primitives";

export function AgentConnectionPanel({ onChange }: { onChange: () => void }) {
  const [value, setValue] = useState(getApiBase());
  const [status, setStatus] = useState<"idle" | "ok" | "fail" | "checking">("idle");
  const [detail, setDetail] = useState("");

  const save = () => {
    const cleaned = value.trim().replace(/\/$/, "");
    if (cleaned) setApiBase(cleaned);
    else clearApiBase();
    setValue(cleaned);
    toast.success(
      cleaned
        ? "Agent connection saved"
        : "Cleared — set VITE_API_BASE or an agent URL to reach a backend",
    );
    onChange();
  };

  const test = async () => {
    setStatus("checking");
    setDetail("");
    // Test against current value (not persisted state) so users can try before saving.
    const cleaned = value.trim().replace(/\/$/, "");
    try {
      const url = `${cleaned}/health`;
      const res = await fetch(url, { credentials: "include" });
      const text = await res.text();
      if (res.ok) {
        setStatus("ok");
        setDetail(text.slice(0, 140) || `${res.status} OK`);
      } else {
        setStatus("fail");
        setDetail(`${res.status} · ${text.slice(0, 100)}`);
      }
    } catch (e) {
      setStatus("fail");
      setDetail(friendlyError(e, "network error"));
    }
  };

  return (
    <div className="panel overflow-hidden">
      <SectionHeader
        icon="⌁"
        right={
          <span className="flex items-center gap-2 normal-case tracking-normal">
            <Dot
              tone={status === "ok" ? "success" : status === "fail" ? "error" : "muted"}
              pulse={status === "ok"}
            />
            {status === "checking"
              ? "testing…"
              : status === "ok"
                ? "backend reachable"
                : status === "fail"
                  ? "unreachable"
                  : hasRealBackend()
                    ? "backend configured"
                    : "no backend"}
          </span>
        }
      >
        AGENT CONNECTION
      </SectionHeader>
      <div className="grid gap-3 p-5 md:grid-cols-[1fr_auto_auto]">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://agentlab.<your-tunnel>.example.com"
          className="min-w-0 rounded-md border border-panel-border bg-background/60 px-3 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={test}
          className="rounded-md border border-panel-border px-4 py-2 font-mono text-[11px] text-foreground hover:border-foreground/40"
        >
          Test
        </button>
        <button
          type="button"
          onClick={save}
          className="rounded-md bg-primary px-4 py-2 font-mono text-[11px] font-medium text-primary-foreground hover:opacity-95"
        >
          Save
        </button>
        {detail && (
          <div
            className={`md:col-span-3 rounded-md border px-3 py-2 font-mono text-[11px] ${
              status === "ok"
                ? "border-primary/30 bg-primary/5 text-foreground"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
          >
            {detail}
          </div>
        )}
        <p className="md:col-span-3 font-mono text-[11px] text-muted-foreground">
          Base URL for the FastAPI agent (named tunnel or deployed host). A reachable backend is
          required — there is no offline demo mode, and every run uses real provider keys. Set{" "}
          <code className="text-foreground/80">VITE_API_BASE</code> at build time or paste one here.
          Cookies use <code className="text-foreground/80">credentials: include</code>; the backend
          must allow this origin.
        </p>
      </div>
    </div>
  );
}

// ─── Idea capture ──────────────────────────────────────────────────────────
// The first step of the workflow: the research question the agent will pursue.

/**
 * A textarea for the project's research idea.
 *
 * Note the `useEffect` below resetting local state when `project.id` changes.
 * That is a genuine pattern to know: this component copies a prop into state so
 * the field is editable, which means the copy goes stale when the prop changes.
 * Switching projects would otherwise leave the previous project's idea in the
 * box — and, worse, saving would write it to the wrong project.
 */
export function IdeaCard({
  project,
  onIdeaSaved,
}: {
  project: ProjectOut;
  onIdeaSaved: (p: ProjectOut) => void;
}) {
  const [idea, setIdea] = useState(
    (project as ProjectOut & { idea_text?: string }).idea_text ?? "",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIdea((project as ProjectOut & { idea_text?: string }).idea_text ?? "");
  }, [project.id]); // reset when switching projects
  // ^ Keyed on `project.id` rather than `project`, so an unrelated field
  //   changing on the same project does not wipe out the user's unsaved edits.
  //
  //   (React's own suggested alternative is to give the component a `key` prop
  //   at the call site — `<IdeaCard key={project.id} …>` — which remounts it
  //   and resets all state automatically. Worth knowing as the cleaner fix.)

  const save = async () => {
    if (!idea.trim()) {
      toast.error("Describe your research idea first");
      return;
    }
    setBusy(true);
    try {
      const updated = await saveIdea(project.id, idea.trim());
      onIdeaSaved(updated);
      toast.success("Idea saved");
    } catch (e) {
      toast.error(friendlyError(e, "Could not save idea"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel overflow-hidden">
      <SectionHeader icon="▤">IDEA CAPTURE</SectionHeader>
      <div className="p-5">
        <label className="mono-label">research idea</label>
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={8}
          placeholder="Describe the research question, hypothesis, and success signals…"
          className="mt-2 w-full rounded-md border border-panel-border bg-background/50 p-4 font-sans text-sm leading-relaxed text-foreground focus:border-primary focus:outline-none"
        />
        <div className="mt-4 flex gap-3">
          <button
            onClick={save}
            disabled={busy}
            className="flex items-center gap-2 rounded-md border border-panel-border bg-background/60 px-4 py-2.5 font-mono text-xs text-foreground hover:border-foreground/40 disabled:opacity-60"
          >
            {busy ? "Saving…" : "⬒ Save Idea"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Brief ────────────────────────────────────────────────────────────────
// Gate G1 and the shared confirmation machinery used by all four gates.
