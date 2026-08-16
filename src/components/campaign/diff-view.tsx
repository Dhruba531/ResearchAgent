// Unified diff renderer for candidate edits.
//
// Renders a git-style patch with syntax colouring. Short, but it contains
// several details that are easy to get wrong, so it is worth reading closely if
// you ever render preformatted text in React.
//
// "Unified diff" is the standard patch format git produces:
//
//   --- a/model.py          ← the original file
//   +++ b/model.py          ← the modified file
//   @@ -14,7 +14,9 @@       ← a "hunk header": where the change starts
//    unchanged context line  ← leading space
//   -removed line            ← leading minus
//   +added line              ← leading plus
//
// The leading character of each line carries the meaning, which is what the
// prefix checks below are reading.

export function DiffView({ diff }: { diff: string | undefined }) {
  // Guard first, then render — an early return keeps the main body free of
  // nesting. `!diff.trim()` also catches a diff that is only whitespace, which
  // would otherwise render as a confusing empty black box.
  if (!diff || !diff.trim()) {
    return (
      <p className="px-6 py-10 text-center font-mono text-[12px] text-muted-foreground">
        no diff recorded for this candidate
      </p>
    );
  }

  // Normalise line endings BEFORE splitting. Windows-authored patches use
  // "\r\n"; splitting on "\n" alone would leave a trailing "\r" on every line,
  // which is invisible but breaks the `startsWith` checks below in ways that
  // are genuinely hard to debug — the colouring would just silently stop
  // working for some files.
  const lines = diff.replace(/\r\n/g, "\n").split("\n");

  return (
    // `<pre>` preserves whitespace, which is essential — indentation is
    // meaningful in a code diff and would otherwise be collapsed by HTML.
    <pre className="max-h-[520px] overflow-auto bg-background/60 font-mono text-[12px] leading-[1.6]">
      {lines.map((line, i) => {
        // Build up the classes for this line, then apply them once at the end.
        // Two variables because the two roles are independent: `cls` colours
        // the TEXT, `bg` tints the whole ROW so a block of additions reads as a
        // solid band rather than as separate coloured lines.
        let cls = "text-muted-foreground";
        let bg = "";

        // ORDER MATTERS in this chain, and it is the one real trap in the file.
        // "+++" also starts with "+", so the file-header check must come FIRST
        // — otherwise the `+++ b/model.py` header would be coloured green as
        // though it were an added line. Each branch is checked most-specific
        // first.
        if (line.startsWith("+++") || line.startsWith("---")) cls = "text-foreground/80";
        else if (line.startsWith("@@")) {
          // Hunk header — the "you are here" marker between changed sections.
          cls = "text-primary";
          bg = "bg-primary/5";
        } else if (line.startsWith("+")) {
          cls = "text-success";
          bg = "bg-success/8"; // very low opacity: a tint, not a highlight
        } else if (line.startsWith("-")) {
          cls = "text-destructive";
          bg = "bg-destructive/8";
        } else cls = "text-foreground/70"; // unchanged context

        return (
          // KEYED BY INDEX, which is normally an anti-pattern — but correct
          // here. The usual objection is that indices break when a list is
          // reordered, inserted into, or filtered. This list is derived from an
          // immutable string and is never mutated: line 5 is always line 5. The
          // rule is not "never use index", it is "only when the list is static".
          <div key={i} className={`flex gap-4 px-4 ${bg}`}>
            {/* Line numbers. `select-none` excludes them from text selection,
                so copying a block of the diff yields the code alone rather than
                code interleaved with line numbers — a genuinely useful touch.
                `shrink-0` stops the fixed-width gutter being squeezed by a long
                code line. */}
            <span className="w-10 shrink-0 select-none text-right text-muted-foreground/40">
              {i + 1}
            </span>
            {/* `whitespace-pre-wrap` keeps the <pre> whitespace behaviour but
                allows wrapping, so a very long line stays readable instead of
                forcing horizontal scrolling; `break-words` handles a single
                unbroken token longer than the container.

                `{line || " "}` substitutes a space for an empty line. An empty
                string renders as a zero-height element, which would visually
                collapse blank lines and misalign the diff against the line
                numbers beside it. */}
            <code className={`whitespace-pre-wrap break-words ${cls}`}>{line || " "}</code>
          </div>
        );
      })}
    </pre>
  );
}
