# dev:http host flag + .env token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use beads-superpowers:subagent-driven-development (recommended) or beads-superpowers:executing-plans to implement this plan task-by-task. Each Task becomes a bead (`bd create -t task --parent <epic-id>`). Steps within tasks use checkbox (`- [ ]`) syntax for human readability.

**Goal:** Replace the insecure-forcing `dev:http` npm script with a Node launcher that loads project `.env`, accepts `--host`/`--port`/`--path`/`--insecure`, and starts HTTP MCP with bearer auth when a token is present.

**Architecture:** Repo-local ESM launcher `scripts/dev-http.mjs` loads `.env` via `dotenv` (devDependency only), merges CLI over env, enforces token-or-insecure policy, then spawns `node dist/index.js`. Production `src/index.ts` and `resolveHttpConfig` stay unchanged.

**Tech Stack:** Node.js ESM, `dotenv` (devDependency), existing `dist/index.js` HTTP transport, vitest for pure-helper unit tests.

## Global Constraints

- Do **not** modify `src/index.ts` or `src/http-transport.ts` for this feature.
- Do **not** add `dotenv` as a production/runtime dependency — **devDependency only**.
- Token is never accepted as a CLI flag (history risk); only `.env` / ambient env.
- Precedence for host/port/path: **CLI > existing process.env > `.env` file**.
- `dotenv` must not override variables already set in the process environment.
- If `OPENCODE_MCP_HTTP_TOKEN` is set after load, **auth wins**: do not set insecure; clear `OPENCODE_MCP_HTTP_INSECURE` if it was set.
- If token missing and no `--insecure` → exit `1` with the exact help text from the design.
- Missing `dist/index.js` → tell user to run `npm run build`, exit `1`.
- Never log the token value.
- Bead parent for implementation epic must reference brainstorming `opencode-mcp-fgo` via `discovered-from`.

---

## File map

| File | Responsibility |
|---|---|
| `scripts/dev-http-env.mjs` | Pure helpers: parse argv, merge env policy, usage text (testable, no side effects) |
| `scripts/dev-http.mjs` | Side-effect entry: load dotenv, call helpers, spawn child |
| `tests/dev-http-env.test.ts` | Unit tests for pure helpers |
| `package.json` | `dev:http` script + `dotenv` devDependency |
| `.env.example` | Documented keys, no secrets |
| `README.md` | Short Local HTTP dev note under Development |

---

### Task 1: Pure helpers + unit tests (TDD)

**Files:**
- Create: `scripts/dev-http-env.mjs`
- Create: `tests/dev-http-env.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `parseArgs(argv: string[]): { host?: string; port?: string; path?: string; insecure: boolean }`
  - `buildChildEnv(input: { fileEnv: Record<string, string>; processEnv: NodeJS.ProcessEnv; flags: ReturnType<typeof parseArgs> }): { env: NodeJS.ProcessEnv; error?: string }`
  - `usage(): string`

**Acceptance Criteria:**
- `parseArgs` accepts `--host`, `--port`, `--path`, `--insecure` and rejects unknown flags / missing values
- `buildChildEnv` applies precedence CLI > processEnv > fileEnv for host/port/path
- Token present ⇒ `OPENCODE_MCP_TRANSPORT=http`, token kept, `OPENCODE_MCP_HTTP_INSECURE` deleted
- No token + `insecure` ⇒ `OPENCODE_MCP_HTTP_INSECURE=true`
- No token + not insecure ⇒ `error` set with required help text
- Never includes token in error/usage strings

- [ ] **Step 1: Write the failing tests**

Create `tests/dev-http-env.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseArgs, buildChildEnv, usage } from "../scripts/dev-http-env.mjs";

describe("parseArgs", () => {
  it("parses host port path insecure", () => {
    expect(
      parseArgs(["--host", "0.0.0.0", "--port", "3001", "--path", "/rpc", "--insecure"]),
    ).toEqual({
      host: "0.0.0.0",
      port: "3001",
      path: "/rpc",
      insecure: true,
    });
  });

  it("defaults insecure false and omits unset flags", () => {
    expect(parseArgs([])).toEqual({ insecure: false });
  });

  it("throws on unknown flag", () => {
    expect(() => parseArgs(["--token", "x"])).toThrow(/unknown/i);
  });

  it("throws when --host missing value", () => {
    expect(() => parseArgs(["--host"])).toThrow(/--host/);
  });

  it("throws on invalid port", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(/port/i);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/port/i);
  });
});

describe("buildChildEnv", () => {
  const baseProcess = {
    PATH: "/usr/bin",
    HOME: "/home/u",
  } as NodeJS.ProcessEnv;

  it("loads token from fileEnv and enables http transport with auth", () => {
    const { env, error } = buildChildEnv({
      fileEnv: { OPENCODE_MCP_HTTP_TOKEN: "secret" },
      processEnv: { ...baseProcess },
      flags: { insecure: false },
    });
    expect(error).toBeUndefined();
    expect(env.OPENCODE_MCP_TRANSPORT).toBe("http");
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBe("secret");
    expect(env.OPENCODE_MCP_HTTP_INSECURE).toBeUndefined();
  });

  it("does not let fileEnv override existing processEnv", () => {
    const { env } = buildChildEnv({
      fileEnv: {
        OPENCODE_MCP_HTTP_TOKEN: "from-file",
        OPENCODE_MCP_HTTP_HOST: "127.0.0.1",
      },
      processEnv: {
        ...baseProcess,
        OPENCODE_MCP_HTTP_TOKEN: "from-process",
        OPENCODE_MCP_HTTP_HOST: "10.0.0.1",
      },
      flags: { insecure: false },
    });
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBe("from-process");
    expect(env.OPENCODE_MCP_HTTP_HOST).toBe("10.0.0.1");
  });

  it("lets CLI override host/port/path over process and file", () => {
    const { env } = buildChildEnv({
      fileEnv: {
        OPENCODE_MCP_HTTP_TOKEN: "t",
        OPENCODE_MCP_HTTP_HOST: "file-host",
        OPENCODE_MCP_HTTP_PORT: "3000",
        OPENCODE_MCP_HTTP_PATH: "/file",
      },
      processEnv: {
        ...baseProcess,
        OPENCODE_MCP_HTTP_HOST: "proc-host",
        OPENCODE_MCP_HTTP_PORT: "3001",
        OPENCODE_MCP_HTTP_PATH: "/proc",
      },
      flags: {
        host: "0.0.0.0",
        port: "4000",
        path: "/mcp",
        insecure: false,
      },
    });
    expect(env.OPENCODE_MCP_HTTP_HOST).toBe("0.0.0.0");
    expect(env.OPENCODE_MCP_HTTP_PORT).toBe("4000");
    expect(env.OPENCODE_MCP_HTTP_PATH).toBe("/mcp");
  });

  it("clears insecure when token is present even if process had insecure", () => {
    const { env } = buildChildEnv({
      fileEnv: { OPENCODE_MCP_HTTP_TOKEN: "t" },
      processEnv: {
        ...baseProcess,
        OPENCODE_MCP_HTTP_INSECURE: "true",
      },
      flags: { insecure: true },
    });
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBe("t");
    expect(env.OPENCODE_MCP_HTTP_INSECURE).toBeUndefined();
  });

  it("allows --insecure without token", () => {
    const { env, error } = buildChildEnv({
      fileEnv: {},
      processEnv: { ...baseProcess },
      flags: { insecure: true },
    });
    expect(error).toBeUndefined();
    expect(env.OPENCODE_MCP_TRANSPORT).toBe("http");
    expect(env.OPENCODE_MCP_HTTP_INSECURE).toBe("true");
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBeUndefined();
  });

  it("errors without token and without insecure", () => {
    const { error } = buildChildEnv({
      fileEnv: {},
      processEnv: { ...baseProcess },
      flags: { insecure: false },
    });
    expect(error).toMatch(/OPENCODE_MCP_HTTP_TOKEN is required/);
    expect(error).toMatch(/--insecure/);
  });
});

describe("usage", () => {
  it("mentions flags and .env token, not a sample secret", () => {
    const u = usage();
    expect(u).toMatch(/--host/);
    expect(u).toMatch(/OPENCODE_MCP_HTTP_TOKEN/);
    expect(u).not.toMatch(/secret|sk-/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/dev-http-env.test.ts
```

Expected: FAIL (module not found / export missing).

- [ ] **Step 3: Implement pure helpers**

Create `scripts/dev-http-env.mjs`:

```js
/**
 * Pure helpers for scripts/dev-http.mjs (no I/O, no process mutation).
 */

export function usage() {
  return `Usage: npm run dev:http -- [--host <addr>] [--port <n>] [--path <p>] [--insecure]

Loads .env from the project root (does not override existing env vars).
Requires OPENCODE_MCP_HTTP_TOKEN in .env or the environment, unless --insecure.

Options:
  --host <addr>   Bind host (OPENCODE_MCP_HTTP_HOST)
  --port <n>      Port 1-65535 (OPENCODE_MCP_HTTP_PORT)
  --path <p>      MCP path (OPENCODE_MCP_HTTP_PATH)
  --insecure      Allow HTTP without a token (local only)

Examples:
  npm run dev:http
  npm run dev:http -- --host 0.0.0.0
  npm run dev:http -- --insecure`;
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ host?: string, port?: string, path?: string, insecure: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ host?: string, port?: string, path?: string, insecure: boolean }} */
  const out = { insecure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--insecure") {
      out.insecure = true;
      continue;
    }
    if (a === "--host" || a === "--port" || a === "--path") {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`Missing value for ${a}\n\n${usage()}`);
      }
      if (a === "--host") out.host = val;
      if (a === "--path") out.path = val;
      if (a === "--port") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new Error(
            `Invalid port "${val}" (must be an integer 1-65535)\n\n${usage()}`,
          );
        }
        out.port = String(n);
      }
      continue;
    }
    throw new Error(`Unknown flag: ${a}\n\n${usage()}`);
  }
  return out;
}

/**
 * Merge fileEnv + processEnv + CLI flags into the child process environment.
 * Precedence for host/port/path: CLI > processEnv > fileEnv.
 * dotenv-style: fileEnv only fills keys not already set in processEnv.
 *
 * @param {{
 *   fileEnv: Record<string, string>,
 *   processEnv: NodeJS.ProcessEnv,
 *   flags: { host?: string, port?: string, path?: string, insecure: boolean }
 * }} input
 * @returns {{ env: NodeJS.ProcessEnv, error?: string }}
 */
export function buildChildEnv({ fileEnv, processEnv, flags }) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...processEnv };

  for (const [k, v] of Object.entries(fileEnv)) {
    if (env[k] === undefined && v !== undefined) {
      env[k] = v;
    }
  }

  if (flags.host !== undefined) env.OPENCODE_MCP_HTTP_HOST = flags.host;
  if (flags.port !== undefined) env.OPENCODE_MCP_HTTP_PORT = flags.port;
  if (flags.path !== undefined) env.OPENCODE_MCP_HTTP_PATH = flags.path;

  env.OPENCODE_MCP_TRANSPORT = "http";

  const token = env.OPENCODE_MCP_HTTP_TOKEN;
  const hasToken = typeof token === "string" && token.length > 0;

  if (hasToken) {
    delete env.OPENCODE_MCP_HTTP_INSECURE;
    return { env };
  }

  if (flags.insecure) {
    env.OPENCODE_MCP_HTTP_INSECURE = "true";
    return { env };
  }

  return {
    env,
    error:
      "dev:http: OPENCODE_MCP_HTTP_TOKEN is required.\n" +
      "Add it to .env, or pass --insecure for local unauthenticated HTTP (not for untrusted networks).",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/dev-http-env.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-http-env.mjs tests/dev-http-env.test.ts
git commit -m "feat(dev-http): pure env/argv helpers with unit tests

opencode-mcp-fgo"
```

---

### Task 2: Launcher, package.json, dotenv, .env.example, docs

**Files:**
- Create: `scripts/dev-http.mjs`
- Create: `.env.example`
- Modify: `package.json` (scripts.dev:http, devDependencies.dotenv)
- Modify: `README.md` (Development section only)

**Interfaces:**
- Consumes: `parseArgs`, `buildChildEnv`, `usage` from `scripts/dev-http-env.mjs`
- Produces: working `npm run dev:http` CLI entrypoint

**Acceptance Criteria:**
- `npm run dev:http` loads `.env` via dotenv without overriding existing env
- CLI flags map to env vars before spawn
- Missing `dist/index.js` exits 1 with build hint
- Missing token without `--insecure` exits 1 with design help text
- With token, child starts HTTP transport (smoke)
- README documents Local HTTP dev
- `.env.example` lists keys with empty/safe placeholders
- `dotenv` is only in `devDependencies`

- [ ] **Step 1: Install dotenv as devDependency**

```bash
npm install --save-dev dotenv
```

Verify `package.json` has `dotenv` under `devDependencies` only (not `dependencies`).

- [ ] **Step 2: Implement launcher**

Create `scripts/dev-http.mjs`:

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { parseArgs, buildChildEnv, usage } from "./dev-http-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distEntry = join(root, "dist", "index.js");
const envPath = join(root, ".env");

// Load .env into a plain object without mutating process.env yet
// (dotenv does not override existing keys by default when assigned to process.env;
//  we still parse into fileEnv for buildChildEnv so precedence is explicit).
const parsed = loadDotenv({ path: envPath, processEnv: {} });
const fileEnv = parsed.parsed ?? {};

let flags;
try {
  flags = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const { env, error } = buildChildEnv({
  fileEnv,
  processEnv: process.env,
  flags,
});

if (error) {
  console.error(error);
  console.error("\n" + usage());
  process.exit(1);
}

if (!existsSync(distEntry)) {
  console.error(
    `dev:http: missing ${distEntry}. Run: npm run build`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [distEntry], {
  env,
  stdio: "inherit",
  cwd: root,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(`dev:http: failed to start: ${err.message}`);
  process.exit(1);
});
```

Note on dotenv: `config({ path, processEnv: {} })` returns `{ parsed }` without writing into the real `process.env`, so `buildChildEnv` owns the merge. If the installed `dotenv` version does not support `processEnv`, use:

```js
import { readFileSync } from "node:fs";
import { parse } from "dotenv";

let fileEnv = {};
if (existsSync(envPath)) {
  fileEnv = parse(readFileSync(envPath));
}
```

Prefer `parse` + `readFileSync` if that is clearer and avoids version API differences — either is acceptable as long as existing process env is not clobbered by the file.

**Preferred final form for dotenv load (use this if `processEnv: {}` is awkward):**

```js
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

let fileEnv = {};
if (existsSync(envPath)) {
  fileEnv = parse(readFileSync(envPath, "utf8"));
}
```

- [ ] **Step 3: Wire package.json script**

In `package.json`, set:

```json
"dev:http": "node scripts/dev-http.mjs"
```

Leave `dotenv` in `devDependencies` (already installed in Step 1).

- [ ] **Step 4: Add `.env.example`**

Create `.env.example`:

```
# Copy to .env and fill in values. .env is gitignored.

# Required for npm run dev:http (unless you pass --insecure)
OPENCODE_MCP_HTTP_TOKEN=

# Optional HTTP bind settings (overridable via CLI flags)
OPENCODE_MCP_HTTP_HOST=127.0.0.1
OPENCODE_MCP_HTTP_PORT=3000
# OPENCODE_MCP_HTTP_PATH=/mcp

# Optional OpenCode upstream
# OPENCODE_BASE_URL=http://127.0.0.1:4096
# OPENCODE_AUTO_SERVE=true
```

- [ ] **Step 5: Document in README Development section**

In `README.md`, under `## Development` after the existing code block (after `npm test`), add:

```markdown
### Local HTTP transport

```bash
cp .env.example .env   # set OPENCODE_MCP_HTTP_TOKEN
npm run build
npm run dev:http
npm run dev:http -- --host 0.0.0.0 --port 3001
npm run dev:http -- --insecure   # no token; local only
```

Endpoint: `http://<host>:<port>/mcp` (default `http://127.0.0.1:3000/mcp`).
Send `Authorization: Bearer <token>` when a token is configured.
```

- [ ] **Step 6: Unit tests still pass + full suite**

```bash
npm test
```

Expected: all existing tests + `dev-http-env` PASS.

- [ ] **Step 7: Smoke (manual / scripted)**

```bash
npm run build

# A) no token, no flag → exit 1
env -u OPENCODE_MCP_HTTP_TOKEN -u OPENCODE_MCP_HTTP_INSECURE \
  npm run dev:http 2>&1 | head -20
# Expected: message containing OPENCODE_MCP_HTTP_TOKEN is required; exit ≠ 0

# B) --insecure → starts (kill after log line)
timeout 8 npm run dev:http -- --insecure 2>&1 || true
# Expected: log line with HTTP transport on http://127.0.0.1:3000/mcp

# C) token from env (simulating .env)
timeout 8 env OPENCODE_MCP_HTTP_TOKEN=test-token-xyz npm run dev:http -- --host 127.0.0.1 2>&1 || true
# Expected: starts WITHOUT "INSECURE" warning; endpoint logged
```

If a previous `npm start` / `dev:http` still holds port 3000 or 4096, stop it first:

```bash
# only if needed
fuser -k 3000/tcp 4096/tcp 2>/dev/null || true
```

- [ ] **Step 8: Commit**

```bash
git add scripts/dev-http.mjs package.json package-lock.json .env.example README.md
git commit -m "feat(dev-http): launcher with --host and .env token

opencode-mcp-fgo"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| `npm run dev:http -- --host …` | Task 2 launcher + Task 1 parseArgs |
| Load token from `.env` | Task 2 dotenv parse + Task 1 buildChildEnv |
| Token → auth on; no force insecure | Task 1 buildChildEnv clears insecure |
| No token → fail unless `--insecure` | Task 1 + Task 2 exit |
| CLI > process.env > `.env` | Task 1 tests + implementation |
| No production binary / index.ts change | Global constraint; no task touches them |
| dotenv devDependency only | Task 2 npm install --save-dev |
| `.env.example` | Task 2 |
| Docs note | Task 2 README |
| Missing dist → build hint | Task 2 launcher |
| Never log token | Task 1 usage/tests + launcher only logs errors without token value |
| `--port` validation 1–65535 | Task 1 parseArgs |
| Unknown flags rejected | Task 1 parseArgs |

---

## Self-review notes (author)

- No TBD/TODO placeholders.
- Helpers isolated so TDD works without spawning OpenCode.
- `dotenv` API: plan prefers `parse(readFileSync)` to avoid `processEnv` option variance.
- Capture gate / ADR optional after execution handoff.
