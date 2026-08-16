// Leaderboard. Sortable archive view with links
// through to each candidate's detail page.
//
// A GOOD FILE TO LEARN FROM. It is self-contained and demonstrates most of the
// React patterns used across this codebase in one readable page:
//   • `useState` for local UI state (sort column, direction, filter)
//   • `useMemo` to avoid recomputing derived data on every render
//   • rendering a list with `.map()` and the `key` prop
//   • a config-driven table, so columns are data rather than repeated markup
//   • client-side sorting and filtering, with no refetch
//
// Note what it does NOT do: it never fetches anything. `rows` arrives as a
// prop. That separation — a parent owns the data, this owns the presentation —
// is why this component is easy to test and reuse.

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LeaderboardRow } from "@/lib/api";
import {
  Chip,
  EmptyState,
  Panel,
  PanelHead,
  StatusPill,
  fmtNum,
  fmtUsd,
} from "./primitives";

// Only the columns that can be sorted. Deriving this union from the sortable
// fields (rather than allowing any string) means `a[sort]` below is a checked
// property access — sorting by a misspelled or non-existent field will not
// compile.
type SortKey = "score" | "cost_usd" | "throughput" | "context_tokens" | "candidate_id";

/**
 * The table's column definitions, as DATA rather than markup.
 *
 * This is the pattern worth taking away from this file. Writing nine <th>
 * elements by hand would mean repeating the same classes nine times and keeping
 * header order manually in sync with body order. Here the header row is one
 * `.map()` over this array, so adding a column is a one-line change.
 *
 * `key: null` marks a column as unsortable — there is no meaningful ordering
 * for "notes", and typing it as `SortKey | null` makes that explicit rather
 * than relying on a convention.
 *
 * `numeric?: true` drives right-alignment. Numbers align right by convention so
 * that digits of the same magnitude line up vertically and are easy to compare.
 */
const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean }[] = [
  { key: "candidate_id", label: "run" },
  { key: null, label: "parent" },
  { key: null, label: "edit family" },
  { key: null, label: "status" },
  { key: "score", label: "score", numeric: true },
  { key: "cost_usd", label: "cost", numeric: true },
  { key: "throughput", label: "throughput", numeric: true },
  { key: "context_tokens", label: "ctx tokens", numeric: true },
  { key: null, label: "notes" },
];

export function LeaderboardTable({ rows }: { rows: LeaderboardRow[] }) {
  // Three pieces of local state. "Local" is the key word: this is view state
  // that only matters to this component, so it lives here rather than in a
  // context or the URL. Compare `campaigns.$id.tsx`, which puts tab selection
  // in the URL because that *should* survive a refresh and be shareable.
  //
  // Sorting by score descending is the sensible default for a leaderboard —
  // the best candidate should be the first thing you see.
  const [sort, setSort] = useState<SortKey>("score");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [family, setFamily] = useState<string>("all");

  // The list of edit families present in the data, for the filter dropdown.
  //
  // `new Set(...)` deduplicates — many candidates share a family, and the
  // dropdown needs each one once. `Array.from` converts the Set back to an
  // array so it can be `.map()`ed in JSX. "all" is prepended as the reset
  // option.
  //
  // Memoised on `[rows]` because deduplication is wasted work on a re-render
  // caused by, say, changing the sort direction — the families cannot have
  // changed unless the rows did.
  const families = useMemo(
    () => ["all", ...Array.from(new Set(rows.map((r) => String(r.edit_family))))],
    [rows],
  );

  // The rows actually rendered, after filtering and sorting.
  const view = useMemo(() => {
    const filtered = family === "all" ? rows : rows.filter((r) => r.edit_family === family);

    // `[...filtered]` — copy BEFORE sorting. `.sort()` mutates the array in
    // place and returns it, so sorting `filtered` directly would mutate the
    // `rows` prop whenever no filter is applied (since `filtered` is then the
    // same array object). Mutating props breaks React's assumption that data
    // flows one way, and produces bugs where the parent's data silently
    // reorders. This one-character-looking detail is genuinely important.
    const sorted = [...filtered].sort((a, b) => {
      // Missing values sort to the bottom: NEGATIVE_INFINITY is less than any
      // real number, so nulls end up last in a descending sort. Without this,
      // arithmetic on `undefined` yields NaN, and NaN comparisons are always
      // false — which leaves the array in an arbitrary order rather than
      // erroring, making it a nasty bug to spot.
      const av = (a[sort] ?? Number.NEGATIVE_INFINITY) as number;
      const bv = (b[sort] ?? Number.NEGATIVE_INFINITY) as number;
      // A comparator returns a negative number, zero, or positive to mean
      // "before", "equal", "after". Subtraction is the standard numeric idiom;
      // swapping the operands reverses the order.
      return dir === "desc" ? bv - av : av - bv;
    });
    return sorted;
  }, [rows, sort, dir, family]);
  // ^ THE DEPENDENCY ARRAY. This is the part beginners most often get wrong.
  //   Every value from the component scope used inside the callback must be
  //   listed. Omit `dir` and clicking a sort arrow would recompute nothing —
  //   the memo would hand back the previous, stale ordering. The `react-hooks`
  //   ESLint rule checks this for you; do not silence it.

  /** Sort handler: same column toggles direction, a new column resets to desc. */
  const toggle = (key: SortKey | null) => {
    // Unsortable column — do nothing. Guarding here rather than at the call
    // site keeps the JSX below simpler.
    if (!key) return;
    if (key === sort) {
      // The FUNCTIONAL form of a setter: `setDir(d => ...)` receives the
      // current value rather than closing over it. Safer than `setDir(dir ===
      // "desc" ? "asc" : "desc")` because it cannot read a stale value from an
      // earlier render, and it is the required form when updates might batch.
      setDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      // Switching column starts at descending — for every column here, "most
      // interesting first" means largest first.
      setSort(key);
      setDir("desc");
    }
  };

  return (
    <Panel>
      <PanelHead
        kicker="archive · metrics table"
        title="Leaderboard"
        subtitle="Every candidate the search has written to the ledger, with its parent, edit family, and cost vector."
        // `meta` receives JSX — the slot pattern described in primitives.tsx.
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {/* Shows the count AFTER filtering, so it reflects what is on
                screen rather than what was loaded. */}
            <Chip tone="info">{view.length} rows</Chip>
            {/* A CONTROLLED COMPONENT: `value` comes from state and `onChange`
                writes back to it. React state is the single source of truth,
                not the DOM. Omitting `onChange` here would freeze the select,
                because `value` would keep forcing it back to the state value. */}
            <select
              value={family}
              onChange={(e) => setFamily(e.target.value)}
              className="rounded border border-panel-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
              // The select has no visible <label>, so this names it for screen
              // readers. Without it the control announces only its current
              // value, with no indication of what it controls.
              aria-label="Filter by edit family"
            >
              {families.map((f) => (
                // `key` lets React match elements across renders so it can
                // update in place instead of rebuilding. Here the family name
                // is a good key: unique (the Set guaranteed it) and stable.
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        }
      />
      {/* A ternary for either/or rendering, rather than the `&&` used for
          optional content in primitives.tsx. */}
      {view.length === 0 ? (
        // Note the hint explains WHY it is empty and what will fill it —
        // far more useful than a bare "No data".
        <EmptyState label="the ledger is empty" hint="Candidates appear as the proposer evaluates edits." />
      ) : (
        // Constrained height plus `overflow-auto` makes the table body scroll
        // inside the panel instead of stretching the page.
        <div className="max-h-[520px] overflow-auto">
          <Table>
            {/* `sticky top-0` pins the header while the body scrolls, so column
                meaning is never lost. It needs the explicit `bg-panel` — a
                transparent sticky header would show rows sliding underneath it,
                and `z-10` keeps it stacked above them. */}
            <TableHeader className="sticky top-0 z-10 bg-panel">
              <TableRow className="border-panel-border hover:bg-transparent">
                {COLUMNS.map((c) => (
                  <TableHead
                    key={c.label}
                    // A template literal appending a conditional class. Note
                    // this file uses raw interpolation rather than the `cn`
                    // helper — fine here since there are no conflicting classes
                    // to resolve, though `cn` would be the safer habit.
                    className={`font-mono text-[10px] uppercase tracking-[0.14em] ${c.numeric ? "text-right" : ""}`}
                  >
                    {/* Sortable columns render a button; the rest render plain
                        text. Using a real <button> rather than a clickable
                        <div> is what makes the header keyboard-accessible and
                        announced correctly by screen readers. */}
                    {c.key ? (
                      <button
                        // `type="button"` prevents the default "submit"
                        // behaviour, which would reload the page if this table
                        // were ever placed inside a <form>.
                        type="button"
                        onClick={() => toggle(c.key)}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {c.label}
                        {/* The arrow appears only on the active sort column,
                            pointing the way the data is ordered. */}
                        {sort === c.key &&
                          (dir === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUp className="h-3 w-3" />
                          ))}
                      </button>
                    ) : (
                      c.label
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((r) => (
                // Keyed by the candidate's own ID — stable and unique. Using
                // the array index here would be a bug: sorting reorders the
                // array, so index 0 would point at a different candidate and
                // React would reuse the wrong DOM node for it.
                <TableRow key={r.candidate_id} className="border-panel-border">
                  <TableCell className="font-mono text-[12px]">
                    {/* TanStack Router's <Link>, not a plain <a>. It navigates
                        client-side — no full page reload — while still
                        rendering a real anchor, so middle-click and
                        "open in new tab" work.

                        `to` is the route PATTERN and `params` fills the `$id`
                        segment. Both are type-checked against the generated
                        route tree, so a typo in the path or a missing param is
                        a compile error rather than a broken link. */}
                    <Link
                      to="/candidates/$id"
                      params={{ id: String(r.candidate_id) }}
                      className="text-primary hover:underline"
                    >
                      c{r.candidate_id}
                      {/* `!= null` catches null and undefined but keeps 0 — see
                          the note in primitives.tsx `fmtNum`. Using `&&` here
                          would hide a legitimate run 0. */}
                      {r.run_id != null && (
                        <span className="text-muted-foreground"> · r{r.run_id}</span>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-[12px] text-muted-foreground">
                    {/* "root" means this candidate began the search rather than
                        being derived from an earlier one. */}
                    {r.parent_id != null ? `c${r.parent_id}` : "root"}
                  </TableCell>
                  <TableCell className="font-mono text-[12px] text-muted-foreground">
                    {r.edit_family}
                  </TableCell>
                  <TableCell>
                    <StatusPill status={r.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12px] text-foreground">
                    {/* The score is the headline metric, so it gets
                        `text-foreground` while the supporting numbers below use
                        the muted colour. Visual hierarchy through contrast. */}
                    {fmtNum(r.score)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                    {fmtUsd(r.cost_usd)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                    {/* 1 decimal place instead of the default 3 — throughput
                        does not need that precision. */}
                    {fmtNum(r.throughput, 1)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                    {/* `toLocaleString()` inserts thousands separators, so
                        128000 reads as "128,000". Large raw digit strings are
                        genuinely hard to scan. */}
                    {r.context_tokens != null ? r.context_tokens.toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate text-[12px] text-muted-foreground">
                    {/* `truncate` clips overflow with an ellipsis, and requires
                        the `max-w-*` beside it to have something to overflow.
                        Without the width cap a long note would stretch the
                        column and break the layout. */}
                    {r.note ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
