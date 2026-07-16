# Design: `dev:http` host flag + `.env` token

**Date:** 2026-07-16  
**Bead:** opencode-mcp-fgo  
**Status:** approved (brainstorming)

## Goal

Make local HTTP MCP dev ergonomic:

1. `npm run dev:http -- --host 0.0.0.0` (and related flags) without hand-exporting env vars.
2. Load `OPENCODE_MCP_HTTP_TOKEN` (and other `OPENCODE_*` vars) from a project-root `.env`.
3. Prefer real bearer auth when a token is present; do not force insecure mode.

## Non-goals

- No CLI flags on the production binary (`dist/index.js` / `npx opencode-mcp`).
- No automatic `.env` load in production `src/index.ts`.
- No change to `resolveHttpConfig` auth rules (token required unless insecure).
- No Docker / multi-env profiles in this change.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Where flags / `.env` live | **Only npm `dev:http`** |
| Token vs insecure | **Token from `.env` → auth on**; without token → fail (or explicit `--insecure`) |
| Implementation shape | **Node launcher + `dotenv` as devDependency**; production binary untouched |

## Architecture

```
npm run dev:http -- [--host H] [--port P] [--path /mcp] [--insecure]
        │
        ▼
scripts/dev-http.mjs
  1. dotenv.config({ path: <repo>/.env })   # never overrides existing process.env
  2. parse argv (host / port / path / insecure)
  3. apply CLI → process.env.OPENCODE_MCP_HTTP_*
  4. set OPENCODE_MCP_TRANSPORT=http
  5. if no OPENCODE_MCP_HTTP_TOKEN and no --insecure → exit 1 with help
  6. if token present → unset OPENCODE_MCP_HTTP_INSECURE (auth wins)
  7. if --insecure and no token → OPENCODE_MCP_HTTP_INSECURE=true
  8. spawn: node <repo>/dist/index.js  (stdio inherited)
        │
        ▼
dist/index.js  (unchanged)
  → startHttp → resolveHttpConfig(process.env)
```

### Files

| Path | Action |
|---|---|
| `scripts/dev-http.mjs` | **Add** — launcher (ESM, no TypeScript compile step) |
| `package.json` | **Change** — `dev:http` → `node scripts/dev-http.mjs`; add `dotenv` to `devDependencies` |
| `.env.example` | **Add** — documented keys only (no secrets) |
| `README.md` / `docs/getting-started.md` or `docs/configuration.md` | **Touch lightly** — one short “Local HTTP dev” note pointing at `npm run dev:http` |
| `src/index.ts`, `src/http-transport.ts` | **No change** |
| `tests/` | **Optional** — small unit test for argv/env merge pure helpers if extracted; not required for first ship if launcher stays tiny |

### `package.json` scripts

```json
"dev:http": "node scripts/dev-http.mjs"
```

Usage:

```bash
# .env contains OPENCODE_MCP_HTTP_TOKEN=...
npm run dev:http
npm run dev:http -- --host 0.0.0.0
npm run dev:http -- --host 0.0.0.0 --port 3001
npm run dev:http -- --insecure   # local only, no token
```

## CLI contract

| Flag | Env written | Default if unset after `.env` |
|---|---|---|
| `--host <addr>` | `OPENCODE_MCP_HTTP_HOST` | existing env / server default `127.0.0.1` |
| `--port <n>` | `OPENCODE_MCP_HTTP_PORT` | existing env / `3000` |
| `--path <p>` | `OPENCODE_MCP_HTTP_PATH` | existing env / `/mcp` |
| `--insecure` | `OPENCODE_MCP_HTTP_INSECURE=true` | only if no token |

Rules:

- Precedence: **CLI > process.env (pre-existing) > `.env` file** for host/port/path (dotenv does not override existing env; CLI applied last).
- Token: never passed as CLI flag (avoids shell history). Only `.env` or ambient env.
- If `OPENCODE_MCP_HTTP_TOKEN` is set after load, do **not** set insecure; clear any ambient `OPENCODE_MCP_HTTP_INSECURE` from earlier `dev:http` habit so auth is not bypassed.
- If token missing and no `--insecure` → print:

  ```
  dev:http: OPENCODE_MCP_HTTP_TOKEN is required.
  Add it to .env, or pass --insecure for local unauthenticated HTTP (not for untrusted networks).
  ```

  exit code `1`.
- Unknown flags → usage + exit `1`.
- Missing `dist/index.js` → message to run `npm run build` + exit `1`.

## `.env` / security

- `.env` already gitignored (`.env`, `.env.*`).
- Ship `.env.example` with placeholders, e.g.:

  ```
  OPENCODE_MCP_HTTP_TOKEN=
  OPENCODE_MCP_HTTP_HOST=127.0.0.1
  OPENCODE_MCP_HTTP_PORT=3000
  # OPENCODE_BASE_URL=http://127.0.0.1:4096
  ```

- `dotenv` is a **devDependency** only; published npm package (`files: dist, README, LICENSE, CHANGELOG`) does not ship the launcher as required runtime — launcher is repo-local for contributors. (If we later want `npx` users to have it, that is out of scope.)
- Binding `--host 0.0.0.0` without a token is dangerous; require token or explicit `--insecure`, and keep the existing server warning when insecure.
- Do not log the token value.

## Error handling

| Case | Behavior |
|---|---|
| No `.env` | OK — continue with ambient env |
| Invalid `--port` | Launcher validates integer 1–65535 before spawn |
| Child process crash | Inherit exit code |
| Port in use | Unchanged (binary / OS error) |

## Testing

- Manual: with `.env` token, `npm run dev:http -- --host 127.0.0.1` → listens, curl with `Authorization: Bearer …` succeeds, without → 401.
- Manual: no token, no flag → exit 1.
- Manual: `--insecure` without token → starts + warning.
- Existing `tests/http-transport.test.ts` remains the contract for `resolveHttpConfig`; no regression expected.

## Docs

One short subsection under Development / Getting Started:

```bash
npm run build
cp .env.example .env   # set OPENCODE_MCP_HTTP_TOKEN
npm run dev:http -- --host 0.0.0.0
# → http://0.0.0.0:3000/mcp
```

## Implementation outline (for writing-plans)

1. Add `dotenv` as `devDependency`.
2. Implement `scripts/dev-http.mjs` (load env, parse flags, auth policy, spawn).
3. Point `package.json` `dev:http` at the launcher.
4. Add `.env.example`.
5. Brief README/docs note.
6. Smoke: build + run with token and with `--insecure`.

## Out of scope / follow-ups

- Watch-mode that rebuilds + restarts HTTP server.
- `--token` CLI flag.
- Loading `.env` in production binary.
- Windows-specific shell wrappers (Node launcher should work on Windows without shell).
