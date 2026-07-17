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
