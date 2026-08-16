// Lineage graph. Parent→child tree of
// candidates laid out by iteration depth, tagged by edit family.
//
// HAND-ROLLED SVG — no charting library. Recharts covers standard plots, but a
// tree layout is not one of them, so this file computes node positions itself
// and emits raw <svg> elements.
//
// That makes it the most algorithmic component in the folder, and a good one to
// study if you have not written SVG in React before. The two halves are:
//
//   1. The `useMemo` — a LAYOUT ALGORITHM. Turns a flat list of candidates
//      (each knowing only its parent's id) into positioned nodes and edges.
//   2. The JSX — draws that geometry: Bézier curves for edges, rounded rects
//      for nodes.
//
// SVG coordinates run with y INCREASING DOWNWARD, so y=0 is the top. Depth 0
// (the seed program) sits at the top and the tree grows downward.

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import type { CandidateOut } from "@/lib/api";
import { CHART_COLORS, Chip, EmptyState, Panel, PanelHead, fmtNum } from "./primitives";

// Layout constants in pixels. Named rather than inlined because each is used in
// several places — node size feeds both the rects and the total canvas size —
// and tuning the spacing means changing one number, not hunting for literals.
const NODE_W = 132;
const NODE_H = 46;
const GAP_X = 28; // horizontal space between siblings
const GAP_Y = 52; // vertical space between generations

/** A candidate plus its computed pixel position. */
type Node = { c: CandidateOut; x: number; y: number };

/**
 * Deterministically map an edit-family name to a palette colour.
 *
 * The requirement is that the same family always gets the same colour — within
 * one render, across re-renders, and between the graph and its legend. A
 * counter or random pick would break as soon as the data reordered.
 *
 * So it hashes the string and indexes the palette with the result. Same input
 * → same colour, always, with no lookup table to maintain as new families
 * appear.
 */
const familyColor = (family: string): string => {
  const palette = [
    CHART_COLORS.primary,
    CHART_COLORS.accent,
    CHART_COLORS.success,
    CHART_COLORS.warning,
    CHART_COLORS.muted,
    CHART_COLORS.danger,
  ];
  // A classic polynomial string hash: `h = h * 31 + charCode`, a variant of
  // Java's String.hashCode. The 31 multiplier and the 997 modulus are both
  // primes, which spreads similar strings ("data" vs "date") to distant hash
  // values rather than adjacent ones. The modulus also keeps `h` small enough
  // to avoid overflowing into imprecise floating-point territory.
  let h = 0;
  for (let i = 0; i < family.length; i++) h = (h * 31 + family.charCodeAt(i)) % 997;
  // Two families CAN collide onto the same colour — with six colours that is
  // unavoidable. Acceptable here, since colour is a secondary cue and the label
  // is printed on every node.
  return palette[h % palette.length];
};

export function LineageGraph({ candidates }: { candidates: CandidateOut[] }) {
  const { nodes, edges, width, height, families } = useMemo(() => {
    // An id → candidate index. Building the Map once turns each parent lookup
    // below from an O(n) array scan into O(1), which matters because `depthOf`
    // walks the chain for every candidate.
    const byId = new Map(candidates.map((c) => [c.id, c]));

    /**
     * How many edits separate this candidate from the seed program?
     *
     * RECURSIVE: a node's depth is its parent's depth plus one, bottoming out
     * at a root (no parent) with depth 0.
     *
     * The `seen` set is CYCLE PROTECTION. Data should never contain a cycle —
     * a candidate that is its own ancestor — but if corrupt data did, naive
     * recursion would loop until the stack overflowed and take the page down.
     * Tracking visited ids turns that crash into a harmless 0.
     *
     * Note `seen` is a default parameter, so external callers just write
     * `depthOf(c)` and the set is created for them.
     */
    const depthOf = (c: CandidateOut, seen = new Set<number>()): number => {
      if (c.parent_id == null || seen.has(c.id)) return 0;
      seen.add(c.id);
      const parent = byId.get(c.parent_id);
      // A parent id pointing at a candidate not in this list (filtered out, or
      // not yet loaded) is treated as a root rather than an error.
      return parent ? depthOf(parent, seen) + 1 : 0;
    };

    // Bucket candidates by depth: one entry per generation.
    const rows = new Map<number, CandidateOut[]>();
    // Sorted by id first, so siblings appear left-to-right in creation order
    // and the layout is stable between renders. Copy before sorting — `.sort()`
    // mutates and `candidates` is a prop.
    for (const c of [...candidates].sort((a, b) => a.id - b.id)) {
      const d = depthOf(c);
      // Rebuilds the array on each append rather than pushing. Immutable in
      // style, though O(n²) over a row; fine at these sizes.
      rows.set(d, [...(rows.get(d) ?? []), c]);
    }

    // Assign pixel positions. `nodes` is for rendering; `pos` is an id → Node
    // index so the edge pass below can find a parent's coordinates.
    const nodes: Node[] = [];
    const pos = new Map<number, Node>();
    for (const [depth, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      list.forEach((c, i) => {
        // x by position within the row, y by depth. Simple and predictable.
        //
        // Worth knowing the limitation: children are NOT positioned under their
        // parents. Each generation is packed left-to-right independently, so
        // edges often cross in a wide tree. A proper tidy-tree algorithm
        // (Reingold–Tilford) would fix that at considerably more complexity;
        // this is a deliberate trade-off, not an oversight.
        const n = { c, x: i * (NODE_W + GAP_X), y: depth * (NODE_H + GAP_Y) };
        nodes.push(n);
        pos.set(c.id, n);
      });
    }

    // Build the edge list. The filter drops candidates whose parent is absent
    // from the graph, which is what makes the `as Node` assertion on the next
    // line safe — `pos.has()` has already proven the lookup succeeds.
    const edges = nodes
      .filter((n) => n.c.parent_id != null && pos.has(n.c.parent_id))
      .map((n) => ({ from: pos.get(n.c.parent_id as number) as Node, to: n }));

    // Canvas size = the furthest node's far edge. The leading `1` serves two
    // purposes: it is the minimum size, and it stops `Math.max()` returning
    // -Infinity when there are no nodes at all.
    //
    // (`...array` as arguments has a practical cap of ~100k elements before
    // hitting the engine's argument limit. Never a concern for a lineage tree.)
    const width = Math.max(
      1,
      ...nodes.map((n) => n.x + NODE_W),
    );
    const height = Math.max(1, ...nodes.map((n) => n.y + NODE_H));

    const families = Array.from(new Set(candidates.map((c) => String(c.edit_family))));
    return { nodes, edges, width, height, families };
  }, [candidates]);

  return (
    <Panel>
      <PanelHead
        kicker="search · parent choice"
        title="Lineage"
        subtitle="Which candidate branched from what. Depth is edit distance from the seed program; colour is the edit family."
        meta={<Chip tone="info">{candidates.length} nodes</Chip>}
      />
      {candidates.length === 0 ? (
        <EmptyState label="no lineage yet" />
      ) : (
        // Scrollable in both directions — a wide tree easily exceeds the panel.
        <div className="max-h-[460px] overflow-auto px-6 py-6">
          {/* `+ 8` adds padding so the outermost node's border is not clipped
              at the canvas edge. `role="img"` with an `aria-label` gives screen
              readers one meaningful description instead of reading out dozens
              of unlabelled shapes. */}
          <svg width={width + 8} height={height + 8} role="img" aria-label="Candidate lineage tree">
            {/* EDGES FIRST. SVG has no z-index — later elements paint over
                earlier ones — so drawing edges before nodes keeps the lines
                behind the boxes rather than across them. */}
            {edges.map((e, i) => {
              // Connect the bottom-centre of the parent to the top-centre of
              // the child.
              const x1 = e.from.x + NODE_W / 2;
              const y1 = e.from.y + NODE_H;
              const x2 = e.to.x + NODE_W / 2;
              const y2 = e.to.y;
              const mid = (y1 + y2) / 2;
              return (
                // Index as key is acceptable here: the array is regenerated
                // wholesale by the memo and never reordered in place.
                <path
                  // An SVG path: M = move to, C = cubic Bézier curve.
                  // `C x1,mid x2,mid x2,y2` places both control points at the
                  // vertical midpoint, which produces the S-curve that leaves
                  // the parent going straight down and arrives at the child
                  // going straight down. Straight diagonal lines would be
                  // harder to follow where many edges converge.
                  key={i}
                  d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`}
                  // Without `fill="none"` SVG would fill the area under the
                  // curve with black — the most common path-drawing mistake.
                  fill="none"
                  stroke={CHART_COLORS.grid}
                  strokeWidth={1.25}
                />
              );
            })}
            {/* NODES SECOND, painted on top of the edges. */}
            {nodes.map((n) => {
              const color = familyColor(String(n.c.edit_family));
              return (
                // `<g>` groups elements; the `transform` shifts the whole group
                // into place so every child can use coordinates relative to the
                // node's own top-left corner. That is why the <text> below uses
                // small numbers like x={12} rather than absolute positions.
                <g key={n.c.id} transform={`translate(${n.x},${n.y})`}>
                  {/* A router <Link> wrapping SVG — clicking a node navigates
                      to that candidate. */}
                  <Link to="/candidates/$id" params={{ id: String(n.c.id) }}>
                    {/* THREE STATUS ENCODINGS on one rect, so status is legible
                        without a legend:
                          invalid   → red border
                          kept      → thicker border (1.75 vs 1)
                          discarded → dashed border
                        `undefined` for strokeDasharray means "no dash", the
                        idiomatic way to conditionally omit an SVG attribute. */}
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={6} // corner radius
                      fill="var(--card)"
                      stroke={n.c.status === "invalid" ? CHART_COLORS.danger : color}
                      strokeWidth={n.c.status === "kept" ? 1.75 : 1}
                      strokeDasharray={n.c.status === "discarded" ? "3 3" : undefined}
                    />
                    {/* A 3px accent stripe down the left edge, carrying the
                        family colour independently of the border — so family
                        stays readable even when the border is showing "invalid"
                        red. */}
                    <rect width={3} height={NODE_H} rx={1.5} fill={color} />
                    {/* SVG <text> is positioned by BASELINE, not by top edge,
                        which is why y=19 and y=34 look like arbitrary numbers —
                        they are tuned to sit inside a 46px-tall box. */}
                    <text x={12} y={19} fill="var(--foreground)" fontSize={11} fontFamily="var(--font-mono)">
                      c{n.c.id} · {fmtNum(n.c.score, 3)}
                    </text>
                    <text x={12} y={34} fill="var(--muted-foreground)" fontSize={9.5} fontFamily="var(--font-mono)">
                      {/* SVG does not wrap or ellipsise text — it would simply
                          overflow the box — so long names are hard-truncated. */}
                      {String(n.c.edit_family).slice(0, 16)}
                    </text>
                  </Link>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {/* The legend calls the same `familyColor` as the nodes, which is what
          guarantees the swatches match. A second colour source here would be a
          bug waiting to happen. */}
      <div className="flex flex-wrap gap-3 border-t border-panel-border px-6 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {families.map((f) => (
          <span key={f} className="inline-flex items-center gap-2">
            <span className="h-1.5 w-4 rounded-full" style={{ background: familyColor(f) }} />
            {f}
          </span>
        ))}
      </div>
    </Panel>
  );
}
