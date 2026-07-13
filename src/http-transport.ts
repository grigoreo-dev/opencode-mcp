import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
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
  close(): void | Promise<void>;
}

/**
 * Factory that builds a fresh transport (already connected to a fresh
 * McpServer) for a single request. Stateless mode: the pair serves one
 * HTTP request and is then garbage-collected.
 */
export type TransportFactory = () => TransportLike | Promise<TransportLike>;

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

/** Request debug logs; enabled via OPENCODE_MCP_DEBUG=true. */
const debugEnabled = () => process.env.OPENCODE_MCP_DEBUG === "true";
function debugLog(msg: string): void {
  if (debugEnabled()) {
    console.error(`[mcp-http ${new Date().toISOString()}] ${msg}`);
  }
}

/** Extract the JSON-RPC method name(s) from a request body for logging. */
function methodOf(body: unknown): string {
  if (Array.isArray(body)) {
    return body.map((m) => (m as any)?.method ?? "?").join(",");
  }
  return (body as any)?.method ?? (body === undefined ? "(stream)" : "?");
}

/**
 * Build the node:http request handler: path routing + optional bearer
 * auth, then hand the request to a FRESH transport+server pair from the
 * factory (stateless mode — no session map, nothing retained between
 * requests, no "Server already initialized" possible, no leak possible).
 * Any Mcp-Session-Id header a client still sends is simply ignored.
 */
export function makeHandler(args: {
  createTransport: TransportFactory;
  path: string;
  token?: string;
}): (req: IncomingMessage, res: ServerResponse, body?: unknown) => void {
  const { createTransport, path, token } = args;

  return (req, res, body) => {
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
    // 3. Fresh transport per request; GC reclaims it after the response.
    debugLog(
      `REQ     ${req.method} method=${methodOf(body)} (${req.socket?.remoteAddress ?? "?"})`,
    );
    void Promise.resolve(createTransport())
      .then((transport) => transport.handleRequest(req, res, body))
      .catch((err) => {
        console.error(
          `HTTP transport error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal server error");
        }
      });
  };
}

/** Read and JSON-parse a request body (for POST/DELETE). */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Start the MCP server over Streamable HTTP in stateless mode. Each HTTP
 * request gets its own StreamableHTTPServerTransport + McpServer pair
 * (sessionIdGenerator: undefined — no sessions, no session state, no
 * cleanup needed). The expensive resource — the OpenCode HTTP client —
 * is shared across all requests.
 */
export async function startHttp(
  client: OpenCodeClient,
  baseUrl: string,
): Promise<void> {
  const cfg = resolveHttpConfig(process.env);

  const createTransport: TransportFactory = async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = createServer(client);
    await server.connect(transport);
    return transport;
  };

  const handler = makeHandler({
    createTransport,
    path: cfg.path,
    token: cfg.token,
  });

  const httpServer = createHttpServer((req, res) => {
    // The transport needs the parsed body for POST since we consume the
    // stream here for routing decisions.
    if (req.method === "POST") {
      void readBody(req)
        .then((body) => handler(req, res, body))
        .catch(() => {
          if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32700, message: "Parse error" },
                id: null,
              }),
            );
          }
        });
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(cfg.port, cfg.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  console.error(
    `opencode-mcp v1.11.0 started (HTTP transport, stateless, on ` +
      `http://${cfg.host}:${cfg.port}${cfg.path} | OpenCode server at ${baseUrl})`,
  );

  const shutdown = () => {
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
