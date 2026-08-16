// A custom hook that reports whether the viewport is phone-sized.
//
// This is a good file to study early: it is short, and it demonstrates the two
// most important rules of `useEffect` — the dependency array and the cleanup
// function — with a real use case rather than a toy one.

import * as React from "react";

// 768px matches Tailwind's `md` breakpoint. Keeping the number in one named
// constant means the JS-side check and the CSS-side breakpoint cannot drift
// apart. If this ever changes, change it here only.
const MOBILE_BREAKPOINT = 768;

/**
 * Returns `true` when the viewport is narrower than 768px, updating live as the
 * window is resized.
 *
 * Naming matters here: any function starting with `use` is a HOOK. React
 * enforces rules on hooks — they may only be called at the top level of a
 * component or another hook, never inside a condition, loop, or callback. The
 * `use` prefix is how the linter knows to check those rules.
 *
 * The point of extracting this into a hook is reuse. Any component can call
 * `useIsMobile()` and get the current answer plus automatic re-rendering when it
 * changes, without duplicating the listener setup.
 */
export function useIsMobile() {
  // Initial state is `undefined`, not `false`, and the distinction is
  // deliberate. `undefined` means "not measured yet". This app renders on the
  // server (SSR), where there is no window and therefore no width to measure.
  // Defaulting to `false` would assert "definitely desktop" before we know,
  // causing a hydration mismatch when the client discovers it is actually a
  // phone. `undefined` honestly represents the unknown state.
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    // Everything inside useEffect runs only in the browser, AFTER render. That
    // is exactly why the `window` access below is safe despite SSR — this
    // callback never executes on the server.

    // `matchMedia` is the browser's media-query API. It fires an event when the
    // query flips between matching and not matching, which is far cheaper than
    // listening to every "resize" event — those fire continuously while you drag
    // a window edge, whereas this fires once, only when the boundary is crossed.
    //
    // `- 1` because CSS max-width is inclusive: `max-width: 767px` matches
    // widths up to and including 767, which is the correct complement of the
    // `< 768` comparison used below. Using 768 here would make the two
    // disagree at exactly 768px.
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    mql.addEventListener("change", onChange);

    // Set the value once immediately. The "change" event only fires on FUTURE
    // crossings of the breakpoint, so without this line the hook would return
    // `undefined` until the user happened to resize their window — which on a
    // phone is never.
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);

    // The returned function is the CLEANUP. React calls it when the component
    // unmounts (and before re-running the effect). Removing the listener here is
    // what prevents a memory leak: without it, every mount would add another
    // listener that keeps a reference to this component's state setter alive
    // forever, and each one would fire on every breakpoint change.
    return () => mql.removeEventListener("change", onChange);
  }, []);
  // ^ The empty dependency array means "run this effect once, on mount, and
  //   never again". With no array at all the effect would re-run after EVERY
  //   render, tearing down and re-adding the listener each time. With values
  //   inside, it would re-run whenever those values changed. Nothing in this
  //   effect depends on props or state, so the correct answer is `[]`.

  // `!!` coerces to a real boolean, collapsing the three-state internal value
  // (true / false / undefined) into the two-state boolean the caller wants.
  // During SSR and the very first client render this yields `false`, meaning
  // consumers get a desktop layout until the measurement lands. That is the
  // intended trade-off — see the comment on the initial state above.
  return !!isMobile;
}
