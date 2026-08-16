# AgentLab Research Hub

Marketing landing page + **operator console** for AgentLab. A single front-end
app (TanStack Start, SSR React 19) that also serves its own auth backend from
the same Worker.

## Stack

- **TanStack Start** (SSR React 19) + **TanStack Router** — file-based routes in `src/routes/`
- **Tailwind v4**, **Radix UI**, **react-hook-form + zod**, **sonner**
- Build: **Vite**, bundling Nitro → Cloudflare Workers
- Package manager: **bun** (`bun.lock`); npm works too. Node ≥ 23.
- Deploy target: **Cloudflare Worker** — `src/server.ts` is the `fetch(request, env, ctx)` entry.

## Getting started

```bash
cp .env.example .env    # then fill in your Supabase values
bun install             # or: npm install
bun run dev             # dev server on :3000, proxies /api → :8000
```

Other commands:

```bash
bun run build           # production build (client + SSR worker → dist/)
bun run lint            # eslint
bun run format          # prettier
npx tsc --noEmit        # type-check
```

## Layout

| Concern | File |
| --- | --- |
| Landing page | `src/routes/index.tsx` |
| Control room / workspace (`/console`) | `src/routes/console.tsx` |
| App shell, `<head>`, providers | `src/routes/__root.tsx` |
| Login/register form | `src/components/operator-console.tsx` |
| Auth + typed API client | `src/lib/api.ts` |
| Supabase browser client | `src/integrations/supabase/client.ts` |
| Provider OAuth (Google) | `src/integrations/supabase/oauth.ts` |
| `/api/*` stub (JSON 404) | `src/server-api.ts` |
| Worker entry (SSR + error wrapper) | `src/server.ts` |
| Generated route tree (do not hand-edit) | `src/routeTree.gen.ts` |

## Auth

Sign-in runs **browser → Supabase Auth** directly; there is no server-side auth
code in this repo.

- Email/password: `supabase.auth.signInWithPassword` / `signUp`, wrapped by
  `login()` and `register()` in `src/lib/api.ts`.
- Google: `src/integrations/supabase/oauth.ts`. Enable the provider and add your
  deployed origin as a redirect URL under **Authentication → Providers** in the
  Supabase dashboard, or the callback is rejected.
- `__root.tsx` subscribes to `supabase.auth.onAuthStateChange` and routes the
  user on return from the OAuth redirect.

## The `/api` split

This app ships **no backend**. `src/server-api.ts` answers every `/api/*` request
with a JSON 404 so client data calls fail predictably instead of parsing an HTML
error page. Point `VITE_API_BASE` at a real backend to enable project/run data.

In dev, `vite.config.ts` proxies `/api` → `http://localhost:8000`; override with
`VITE_API_PROXY_TARGET`.

## Environment

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored — never commit
real keys.

`VITE_*` values are **inlined into the client bundle at build time**, not read at
runtime, so they must be present when you build. Only put publishable keys there.

## Deploy (Cloudflare Workers)

The build already targets Workers — Nitro emits `.output/server/wrangler.json`
with the asset binding and compatibility flags set, so no `wrangler.toml` is
needed.

```bash
npm install
npx wrangler login                 # once

VITE_SUPABASE_URL=… \
VITE_SUPABASE_PUBLISHABLE_KEY=… \
VITE_SUPABASE_PROJECT_ID=… \
  npm run build

npx wrangler deploy --config .output/server/wrangler.json
```

Then add the resulting `*.workers.dev` origin to Supabase's redirect allow-list,
or OAuth sign-in will fail on the deployed site.
