// Applies the console's colour theme at the document level.
//
// This file solves a specific problem caused by React PORTALS, explained on
// `useWorkspaceTheme` below. It also shows a pattern worth recognising: the same
// logic exposed both as a hook and as a component.

import { useEffect } from "react";

/**
 * Applies the workspace (black / white / blue) palette to the document root so
 * that portalled UI — dialogs, sheets, dropdowns, tooltips, toasts — inherits
 * the same tokens as the in-tree console markup.
 *
 * The reason this cannot be done with an ordinary wrapper <div>:
 *
 * Radix components (which every dialog, dropdown, and tooltip in this app is
 * built on) render into a PORTAL. A portal escapes the React tree's DOM
 * position and mounts the element at the end of <body> instead. That is
 * necessary for correct stacking and for avoiding `overflow: hidden` clipping
 * from ancestors.
 *
 * But CSS variables cascade through the DOM, not through the React tree. So a
 * `.theme-console` class on some wrapper deep inside the page would style the
 * page fine, and completely miss every portalled dialog — they sit outside that
 * wrapper in the DOM. You would get a correctly themed console with jarringly
 * unthemed modals on top of it.
 *
 * Putting the class on <html> (`document.documentElement`) sidesteps this
 * entirely: it is the ancestor of everything, including <body> and therefore
 * including every portal.
 */
export function useWorkspaceTheme(): void {
  useEffect(() => {
    // Direct DOM manipulation, which is normally discouraged in React. It is
    // appropriate here precisely because <html> lives outside the React tree —
    // React does not own that element, so there is nothing to conflict with.
    const el = document.documentElement;
    el.classList.add("theme-console");

    // Cleanup removes the class on unmount. Without this the console theme
    // would persist after navigating to a non-console page, since nothing else
    // ever takes it off. Effects that ADD something almost always need a
    // cleanup that REMOVES it — that symmetry is the thing to internalise.
    return () => el.classList.remove("theme-console");
  }, []); // Runs once on mount; see use-mobile.tsx for what the empty array means.
}

/**
 * Component wrapper around the hook above.
 *
 * Returning `null` means this component renders NOTHING. It exists purely for
 * its side effect. That is a legitimate and fairly common React pattern — it
 * lets you activate behaviour declaratively from JSX:
 *
 *   <WorkspaceTheme />
 *
 * Why have both forms? A hook can only be called from inside a component body,
 * so it is the right choice when the consumer is already a component that wants
 * the theme. The component form is useful when you want to drop the behaviour
 * into a tree without modifying the surrounding component — for instance inside
 * a layout's JSX, or conditionally: `{isConsole && <WorkspaceTheme />}`.
 */
export function WorkspaceTheme() {
  useWorkspaceTheme();
  return null;
}
