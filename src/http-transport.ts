import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import type { OpenCodeClient } from "./client.js";

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
    ? Number(env.OPENCODE_MCP_HTTP_PORT)
    : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid OPENCODE_MCP_HTTP_PORT="${env.OPENCODE_MCP_HTTP_PORT}" (must be an integer 1-65535).`,
    );
  }
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

function isLocalhost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Start the MCP server over Streamable HTTP. Resolves config from env,
 * builds one McpServer + one transport, and listens on a node:http server.
 */
export async function startHttp(
  client: OpenCodeClient,
  baseUrl: string,
): Promise<void> {
  const cfg = resolveHttpConfig(process.env);

  const local = isLocalhost(cfg.host);
  const allowedHosts = local
    ? [
        `${cfg.host}:${cfg.port}`,
        `127.0.0.1:${cfg.port}`,
        `localhost:${cfg.port}`,
      ]
    : undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: local,
    allowedHosts,
  });

  const server = createServer(client);
  await server.connect(transport);

  const handler = makeHandler({
    transport,
    path: cfg.path,
    token: cfg.token,
  });

  const httpServer = createHttpServer(handler);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(cfg.port, cfg.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  console.error(
    `opencode-mcp v1.11.0 started (HTTP transport on ` +
      `http://${cfg.host}:${cfg.port}${cfg.path} | OpenCode server at ${baseUrl})`,
  );

  const shutdown = () => {
    void transport.close();
    httpServer.close();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
}
