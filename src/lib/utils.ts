// Shared class-name helper. Almost every component in this repo imports `cn`,
// so it is worth understanding properly before reading anything else.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names safely.
 *
 * This does TWO different jobs, which is why it wraps two libraries:
 *
 * 1. `clsx(inputs)` flattens whatever you pass in into one string. It accepts
 *    strings, arrays, `undefined`, and objects, and drops anything falsy. That
 *    is what lets you write conditional classes inline:
 *
 *      cn("p-4", isActive && "bg-blue-500", { "opacity-50": disabled })
 *
 *    If `isActive` is false, `false` is simply skipped instead of ending up in
 *    the output as the literal text "false".
 *
 * 2. `twMerge(...)` resolves Tailwind conflicts by letting the LAST class win.
 *    Plain string concatenation cannot do this. Given "p-2 p-8", both classes
 *    land in the HTML and the winner depends on Tailwind's internal stylesheet
 *    order — not on the order you wrote them. twMerge understands that `p-2`
 *    and `p-8` target the same CSS property and keeps only `p-8`.
 *
 * That second behaviour is the whole reason this helper exists. It makes the
 * `className` prop overridable: a component can define its own base styles and
 * still let a caller pass `className="p-8"` to override them.
 *
 *   function Panel({ className }) {
 *     return <div className={cn("p-2 rounded border", className)} />;
 *   }
 *   <Panel className="p-8" />   // -> "rounded border p-8", the p-2 is gone
 *
 * The `...inputs` rest parameter collects every argument into an array, so `cn`
 * takes any number of arguments. `ClassValue` is clsx's type covering all the
 * accepted shapes (string, number, null, undefined, array, object).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
