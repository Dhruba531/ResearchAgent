// The public changelog page. The simplest route in the app: no data fetching,
// no auth guard, no state — just static content rendered from an array.
//
// Read it for the CONTENT-AS-DATA pattern (see `RELEASES` below), which is how
// this file stays maintainable as the list grows.
//
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/changelog")({
  head: () => ({
    meta: [
      { title: "Changelog — AgentLab" },
      { name: "description", content: "What's shipped in AgentLab — the governed agent research platform." },
      { property: "og:title", content: "Changelog — AgentLab" },
    ],
  }),
  component: ChangelogPage,
});

// The content model. Three small types describing a changelog:
// a Release has many Entries, each tagged with what kind of change it was.
type Tag = "added" | "changed" | "fixed";
type Entry = { tag: Tag; text: string };
type Release = { version: string; date: string; title: string; entries: Entry[] };

// Honest, source-grounded history — each entry reflects something that actually
// exists in the codebase. Add new releases at the top.
/**
 * CONTENT AS DATA — the pattern this file exists to demonstrate.
 *
 * The alternative would be writing each release as hand-authored JSX: repeated
 * headings, repeated list markup, repeated styling. Storing the content as a
 * typed array instead means the markup is written ONCE below and mapped over,
 * so adding a release is appending an object rather than copying a block of
 * JSX and hoping the classes match.
 *
 * The `Release[]` annotation is what makes it safe: a typo'd tag or a missing
 * date fails to compile rather than rendering wrong.
 */
const RELEASES: Release[] = [
  {
    version: "v0.9",
    date: "Jun 20, 2026",
    title: "Authentication & control room",
    entries: [
      { tag: "added", text: "Operator console sign-in and registration with validated forms; a successful login routes you into the control room." },
      { tag: "added", text: "In-app session auth on the edge — HMAC-signed, HttpOnly cookies with no external database, so it runs on the deployed Worker." },
      { tag: "changed", text: "“Enter control room” now performs a real authentication round-trip instead of a placeholder action." },
    ],
  },
  {
    version: "v0.8",
    date: "Jun 20, 2026",
    title: "Operator console workspace",
    entries: [
      { tag: "added", text: "New /console workspace: project sidebar, idea capture, and a human brief-approval gate." },
      { tag: "added", text: "Run setup with a cost gate, streaming run logs, an artifacts & draft view, reviewer panel, and final export." },
    ],
  },
  {
    version: "v0.7",
    date: "Jun 20, 2026",
    title: "Landing & foundations",
    entries: [
      { tag: "changed", text: "Rebuilt the landing page in the serif + mono dark aesthetic — hero, run preview, and fleet overview." },
    ],
  },
];

// Tag → styling lookup. `Record<Tag, …>` forces an entry for every tag, so
// adding a fourth kind of change becomes a compile error until it is styled.
// The same exhaustiveness technique used throughout `campaign/primitives.tsx`.
const TAG_STYLES: Record<Tag, { dot: string; label: string }> = {
  added: { dot: "bg-primary", label: "text-primary" },
  changed: { dot: "bg-warning", label: "text-warning" },
  fixed: { dot: "bg-[oklch(0.72_0.12_240)]", label: "text-[oklch(0.72_0.12_240)]" },
};

function TagPill({ tag }: { tag: Tag }) {
  const s = TAG_STYLES[tag];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-panel-border bg-background/50 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider">
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      <span className={s.label}>{tag}</span>
    </span>
  );
}

function ChangelogPage() {
  return (
    <div className="min-h-screen">
      {/* top bar */}
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid h-6 w-6 place-items-center rounded-[5px] bg-primary">
              <span className="h-2 w-2 rounded-sm bg-primary-foreground" />
            </span>
            <span className="font-serif text-xl text-foreground">AgentLab</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm text-muted-foreground">
            <Link to="/" className="hover:text-foreground">
              Home
            </Link>
            <Link
              to="/console"
              search={{ tl: undefined }}
              className="hover:text-foreground"
            >
              Console
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-16">
        <span className="mono-label">changelog</span>
        <h1 className="mt-3 font-serif text-6xl leading-[0.95] tracking-[-0.02em] text-foreground">
          What we&apos;ve shipped.
        </h1>
        <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
          AgentLab is in active development. Every entry below maps to something live in the
          product — no placeholder build numbers.
        </p>

        <div className="mt-14 space-y-12">
          {RELEASES.map((release) => (
            <section
              key={release.version}
              className="grid gap-6 border-t border-border/60 pt-8 md:grid-cols-[180px_1fr]"
            >
              <div className="md:pt-1">
                <div className="font-serif text-2xl text-foreground">{release.version}</div>
                <div className="mono-label mt-1.5">{release.date}</div>
              </div>
              <div className="panel p-6">
                <h2 className="font-serif text-xl text-foreground">{release.title}</h2>
                <ul className="mt-5 space-y-4">
                  {release.entries.map((entry, i) => (
                    <li key={i} className="grid gap-2 sm:grid-cols-[88px_1fr] sm:items-baseline">
                      <TagPill tag={entry.tag} />
                      <span className="text-sm leading-relaxed text-muted-foreground">{entry.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-16 border-t border-border/60 pt-8">
          <Link
            to="/"
            className="font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Back to home
          </Link>
        </div>
      </main>
    </div>
  );
}
