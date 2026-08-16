// The fallback error page, served when the app has failed badly enough that it
// cannot render itself.
//
// This is the one place in the entire repo with hand-written HTML and CSS —
// everywhere else you will find React components and Tailwind classes. The
// difference is not stylistic, it is structural: this page must work when React
// is broken. If it imported a component, or relied on the stylesheet, or needed
// JavaScript to hydrate, it would fail in exactly the situations it exists for.
//
// So everything is inlined into one self-contained string with zero
// dependencies: no imports, no external CSS file, no bundled JS. A plain
// template literal that returns finished HTML.

/**
 * Return the complete error page as an HTML string.
 *
 * Callers (server.ts and start.ts) pass the result straight into
 * `new Response(html, { status: 500, headers: { "content-type": "text/html" }})`.
 *
 * Note there is no interpolation of any error detail into this template. That
 * is a security decision, and it also removes any risk of HTML injection: with
 * nothing dynamic going in, there is nothing to escape.
 */
export function renderErrorPage(): string {
  // A template literal (backticks) rather than quotes, so the HTML can span
  // multiple lines and keep its indentation.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>This page didn't load</title>
    <!-- Required for sensible rendering on phones. Without this tag mobile
         browsers assume a ~980px desktop layout and zoom out, making the text
         unreadably small. -->
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- Inline <style> rather than a linked stylesheet: a <link> would be a
         second network request that could fail for the same reason the page
         did. Everything needed to render arrives in this one response. -->
    <style>
      /* system-ui uses whatever font the operating system already uses, so
         nothing has to be downloaded. A web font here could fail to load.
         "15px/1.5" is the font shorthand: size 15px, line-height 1.5x.
         display:grid + place-items:center is the shortest way to centre a child
         both horizontally and vertically. min-height:100vh makes body fill the
         viewport, which is what gives the centring something to centre within. */
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      /* max-width caps the line length on desktop (long lines are hard to read)
         while width:100% lets it shrink on narrow screens. That pairing is the
         standard responsive container idiom. */
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0 0 1.5rem; }
      /* flex-wrap lets the two buttons stack instead of overflowing if the
         viewport is too narrow to fit them side by side. */
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
      /* Styling <a> and <button> together so the link and the button look
         identical despite being different elements. "font: inherit" is the load-
         bearing part — buttons do NOT inherit font settings by default, so
         without it the button would render in the browser's default font while
         the link used system-ui. The transparent border reserves the 1px so
         .secondary can colour it in without shifting the layout. */
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: #111; color: #fff; }
      .secondary { background: #fff; color: #111; border-color: #d1d5db; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>This page didn't load</h1>
      <!-- Deliberately vague. The real error is logged server-side; telling the
           user "Something went wrong on our end" avoids exposing stack traces,
           file paths, or dependency details to the browser. -->
      <p>Something went wrong on our end. You can try refreshing or head back home.</p>
      <div class="actions">
        <!-- An inline onclick handler, which you would never write in the React
             part of this app. It is correct here because there is no bundled
             JavaScript on this page to attach a listener from — this one
             attribute is the entire client-side behaviour. -->
        <button class="primary" onclick="location.reload()">Try again</button>
        <!-- A plain <a href>, not a router <Link>. The router may well be the
             thing that crashed, so this triggers a full page load from the
             server rather than a client-side navigation. -->
        <a class="secondary" href="/">Go home</a>
      </div>
    </div>
  </body>
</html>`;
}
