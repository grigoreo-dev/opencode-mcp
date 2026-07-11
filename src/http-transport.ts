export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  token?: string;
  insecure: boolean;
}

/**
 * Resolve and validate HTTP transport config from env vars.
 * Enforces: a bearer token is required unless OPENCODE_MCP_HTTP_INSECURE=true.
 * @param warn sink for the insecure-mode warning (defaults to console.error)
 * @throws Error when http is requested without a token and without insecure opt-out
 */
export function resolveHttpConfig(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = (m) => console.error(m),
): HttpConfig {
  const token = env.OPENCODE_MCP_HTTP_TOKEN || undefined;
  const insecure = env.OPENCODE_MCP_HTTP_INSECURE === "true";

  if (!token && !insecure) {
    throw new Error(
      "HTTP transport requires OPENCODE_MCP_HTTP_TOKEN. " +
        "Set a token, or explicitly disable auth with " +
        "OPENCODE_MCP_HTTP_INSECURE=true (insecure).",
    );
  }
  if (!token && insecure) {
    warn(
      "WARNING: OPENCODE_MCP_HTTP_INSECURE=true — HTTP transport is running " +
        "without authentication. Do not expose this endpoint to untrusted networks.",
    );
  }

  const host = env.OPENCODE_MCP_HTTP_HOST || "127.0.0.1";
  const port = env.OPENCODE_MCP_HTTP_PORT
    ? parseInt(env.OPENCODE_MCP_HTTP_PORT, 10)
    : 3000;
  let path = env.OPENCODE_MCP_HTTP_PATH || "/mcp";
  if (!path.startsWith("/")) path = "/" + path;

  return { host, port, path, token, insecure };
}
