# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 (api-server), Next.js 14 (web-proxy)
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle for api-server), Next.js build (web-proxy)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run Express API server locally
- `pnpm --filter @workspace/web-proxy run dev` — run Next.js web proxy locally (port 3000)
- `pnpm --filter @workspace/web-proxy run build` — build Next.js app for production

## Artifacts

### web-proxy (`artifacts/web-proxy/`)
A full-featured Next.js 14 web proxy deployable on Vercel.

**Key features:**
- Single catch-all API route at `/api/proxy?url=<encoded-url>`
- HTML rewriting via Cheerio: rewrites href, src, srcset, action, poster, data-src, inline styles, `<style>` blocks
- CSS rewriting: rewrites `url()` references
- Runtime JS interceptor: intercepts `fetch()`, `XMLHttpRequest`, `history.pushState/replaceState`
- Forwards request headers, strips security headers (CSP, X-Frame-Options, HSTS)
- Cookie forwarding (strips domain/secure/samesite for cross-origin compat)
- Handles all asset types: HTML, CSS, JS, JSON, SVG, binary (images/fonts/audio/video)
- 25s timeout with Vercel `maxDuration: 30` configured in `vercel.json`

**Structure:**
- `src/app/page.tsx` — Homepage UI with URL bar and example chips
- `src/app/api/proxy/route.ts` — Main proxy handler (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
- `src/lib/rewrite.ts` — URL rewriting utilities (HTML, CSS, srcset, JS interceptor generation)
- `next.config.mjs` — Next.js config (10MB body limit, open image domains)
- `vercel.json` — Sets `maxDuration: 30` for the proxy function

**Deploying to Vercel:**
1. Push the repo (or just `artifacts/web-proxy/`) to GitHub
2. Import into Vercel, set root directory to `artifacts/web-proxy`
3. Deploy — no env vars required for basic operation

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
