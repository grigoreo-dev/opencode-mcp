# ADR-0001: dev:http launcher (not production CLI) for host flags and .env

**Date:** 2026-07-16  
**Status:** Accepted  
**Related:** brainstorming opencode-mcp-fgo, design `.internal/specs/2026-07-16-dev-http-host-env-design.md`

## Context

Local HTTP MCP development needs ergonomic bind address control (`--host`) and
bearer token configuration. Tokens today live only in environment variables;
the temporary `dev:http` npm script forced `OPENCODE_MCP_HTTP_INSECURE=true`.

Options considered:

1. Add CLI flags to the production `opencode-mcp` binary.
2. Load `.env` inside `src/index.ts` for all entrypoints (including `npx`).
3. Keep production env-only; add a repo-local `dev:http` Node launcher with
   dotenv (devDependency) and argv flags.

## Decision

Use option 3: a repo-local launcher (`scripts/dev-http.mjs` + pure helpers)
wired as `npm run dev:http`. Production binary remains environment-variable
only. `dotenv` is a devDependency. Token is never a CLI flag. Auth policy:
token present → bearer auth (clear insecure); no token → require `--insecure`
or fail.

## Rationale

- Avoids expanding the production CLI surface and shipping dotenv to `npx`
  consumers who never need file-based env loading.
- Preserves the existing security contract in `resolveHttpConfig` (token
  required unless explicit insecure opt-out).
- CLI flags stay in the developer entrypoint where `--host 0.0.0.0` is common;
  MCP clients continue to configure via env / JSON configs.

## Consequences

- Contributors use `npm run dev:http -- --host …` after `npm run build`.
- Published package behavior unchanged for `npx -y opencode-mcp`.
- Insecure default for `dev:http` is removed; local `.env` + token is preferred.
- Windows/macOS/Linux share one Node launcher (no shell-specific scripts).
