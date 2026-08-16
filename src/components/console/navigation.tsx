// Console chrome: the sidebar, topbar, project rail, and new-project sheet.

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Home, LogOut } from "lucide-react";
import {
  createProject,
  getApiBase,
  health,
  setApiBase,
  type ProjectOut,
  type UserOut,
} from "@/lib/api";
import { Dot, Logomark, StatusBadge, friendlyError } from "./primitives";
import { Gated } from "./gating";

export const NAV_ITEMS: { href: string; label: string; hint: string }[] = [
  { href: "#workspace", label: "Workspace", hint: "projects" },
  { href: "#pipeline", label: "Pipeline", hint: "run state" },
  { href: "#review", label: "Review", hint: "gates" },
  { href: "#export", label: "Export", hint: "bundle" },
];

/** The fixed left sidebar: logo, section links, role badge, sign-out. */
export function ConsoleSidebar({
  user,
  onLogout,
  loggingOut,
}: {
  user: UserOut;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[260px] shrink-0 flex-col border-r border-border bg-panel/70 px-5 py-6 lg:flex">
      <Logomark />

      <div className="mt-6 flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 font-mono text-[10.5px] tracking-[0.12em] text-foreground/90">
        <Dot /> session active
      </div>

      <nav className="relative mt-7 pl-3">
        <p className="mono-label pb-3">pipeline</p>
        <span
          aria-hidden
          className="absolute bottom-2 left-[1.35rem] top-9 w-px bg-gradient-to-b from-primary/60 via-accent/40 to-transparent"
        />
        <div className="space-y-1">
          {NAV_ITEMS.map((item, i) => (
            <a
              key={item.href}
              href={item.href}
              className="group relative flex items-center gap-3 rounded-lg py-2 pl-0 pr-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-panel-border bg-background font-mono text-[10px] text-muted-foreground transition-colors group-hover:border-primary group-hover:text-primary">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="font-mono text-[10px] text-muted-foreground/60">{item.hint}</span>
            </a>
          ))}
        </div>
      </nav>

      <div className="mt-6 pl-3">
        <p className="mono-label pb-3">search harness</p>
        <Link
          to="/campaigns"
          className="flex items-center gap-3 rounded-lg border border-panel-border bg-background/60 px-3 py-2 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground"
        >
          <span className="font-mono text-[10px] text-primary">∞</span>
          <span className="min-w-0 flex-1 truncate">Campaigns</span>
          <span className="font-mono text-[10px] text-muted-foreground/60">archive</span>
        </Link>
      </div>

      <div className="mt-auto space-y-2 pt-6">
        <div className="rounded-xl border border-panel-border bg-background/70 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-primary/40 bg-primary/10 font-mono text-[12px] uppercase text-primary">
              {(user.name || user.email || "?").slice(0, 1)}
            </span>
            <p
              className="min-w-0 flex-1 truncate text-[13px] text-foreground"
              title={user.name || user.email || undefined}
            >
              {user.name || (user.email ?? "").split("@")[0] || "account"}
            </p>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <Link
              to="/"
              aria-label="Back to site"
              title="Back to site"
              className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-panel-border text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
            >
              <Home className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Site</span>
            </Link>
            <button
              onClick={onLogout}
              disabled={loggingOut}
              aria-label="Sign out"
              title="Sign out"
              className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-panel-border text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-foreground disabled:opacity-60"
            >
              <LogOut className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** The sticky top bar: the active project's name and its current run state. */
export function ConsoleTopbar({
  user,
  onLogout,
  loggingOut,
}: {
  user: UserOut;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 lg:hidden">
      <div className="flex h-14 items-center justify-between gap-4 px-4">
        <Logomark />
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full border border-primary/40 bg-primary/10 font-mono text-[11px] uppercase text-primary">
            {(user.name || user.email || "?").slice(0, 1)}
          </span>
          <button
            onClick={onLogout}
            disabled={loggingOut}
            aria-label="Sign out"
            title="Sign out"
            className="grid h-7 w-7 place-items-center rounded-md border border-panel-border bg-panel text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * The "New project" button and its inline creation form.
 *
 * The button itself is `Gated` on `project:create`, so a viewer sees it
 * disabled with an explanatory tooltip rather than missing entirely.
 */
export function NewProjectSheet({ onCreate }: { onCreate: (project: ProjectOut) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    setBusy(true);
    try {
      const project = await createProject({
        title: title.trim(),
        objective: objective.trim() || undefined,
      });
      onCreate(project);
      setTitle("");
      setObjective("");
      setOpen(false);
      toast.success("Project created", { description: project.title });
    } catch (e) {
      toast.error(friendlyError(e, "Could not create project"));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Gated
        perm="project:create"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        + New project
      </Gated>
    );
  }

  return (
    <div className="panel w-full max-w-xl overflow-hidden p-5">
      <div className="mono-label mb-3">new project</div>
      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Project title"
          className="w-full rounded-md border border-panel-border bg-background/60 px-3 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
        />
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Objective (optional)"
          rows={3}
          className="w-full resize-none rounded-md border border-panel-border bg-background/60 px-3 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-95 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create"}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md border border-panel-border px-4 py-2 font-mono text-[11px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The horizontal project switcher. Selecting one drives `activeId` upward. */
export function ProjectRail({
  projects,
  activeId,
  setActiveId,
}: {
  projects: ProjectOut[];
  activeId: number | null;
  setActiveId: (id: number) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {projects.map((p) => {
        const active = p.id === activeId;
        return (
          <button
            key={p.id}
            onClick={() => setActiveId(p.id)}
            className={`group shrink-0 rounded-md border px-4 py-2.5 text-left transition-colors ${
              active
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-panel-border bg-panel/50 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <StatusBadge status={p.status} />
            </div>
            <div className="mt-1 max-w-[220px] truncate font-mono text-[12px] text-foreground">
              {p.title}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Agent connection panel ────────────────────────────────────────────────

// ─── Setup ─────────────────────────────────────────────────────────────────

/**
 * Point the app at a backend, and test that it responds.
 *
 * This is the UI over `getApiBase` / `setApiBase` in lib/api.ts — it writes the
 * base URL into localStorage, which takes precedence over the build-time
 * `VITE_API_BASE`. That is what lets a user aim the deployed app at their own
 * FastAPI runner without a rebuild.
 *
 * The "Test" button calls `health()` first, so a typo is caught here rather
 * than surfacing later as an unexplained failure on every other request.
 */
