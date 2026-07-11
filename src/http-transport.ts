import type { IncomingMessage, ServerResponse } from "node:http";

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

interface TransportLike {
  handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void>;
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/**
 * Build the node:http request handler: path routing + optional bearer auth,
 * then delegate everything (GET/POST/DELETE, body parsing, method dispatch,
 * JSON-RPC errors) to the transport.
 */
export function makeHandler(args: {
  transport: TransportLike;
  path: string;
  token?: string;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { transport, path, token } = args;
  return (req, res) => {
    // 1. Route by pathname (ignore query string).
    const pathname = (req.url || "").split("?")[0];
    if (pathname !== path) {
      sendJsonRpcError(res, 404, -32001, "Not found");
      return;
    }
    // 2. Bearer auth when a token is configured.
    if (token) {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${token}`) {
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }
    }
    // 3. Delegate to the transport (handles method, body, session, errors).
    void transport.handleRequest(req, res).catch((err) => {
      console.error(
        `HTTP transport handleRequest error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    });
  };
}
