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
  sessionId?: string;
  onclose?: () => void;
  handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Factory that builds a fresh transport for a new MCP session. The factory
 * receives an `onsessioninitialized` callback which MUST be invoked with the
 * session id once the transport has completed the initialize round-trip
 * (StreamableHTTPServerTransport does this natively).
 */
export type TransportFactory = (opts: {
  onsessioninitialized: (sessionId: string) => void;
}) => TransportLike | Promise<TransportLike>;

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

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(
      (m) => m && typeof m === "object" && (m as any).method === "initialize",
    );
  }
  return (
    !!body && typeof body === "object" && (body as any).method === "initialize"
  );
}

/**
 * Build the node:http request handler with per-session transports:
 * path routing + optional bearer auth, then route by Mcp-Session-Id —
 * an initialize request without a session creates a fresh transport
 * (fixing "Server already initialized" for reconnecting clients),
 * known sessions are delegated to their own transport, unknown sessions
 * get 404 (client restarts the session), and non-initialize requests
 * without a session get 400.
 *
 * Exposes `closeAll()` on the returned handler for shutdown.
 */
/** Session lifecycle debug logs; enabled via OPENCODE_MCP_DEBUG=true. */
const debugEnabled = () => process.env.OPENCODE_MCP_DEBUG === "true";
function debugLog(msg: string): void {
  if (debugEnabled()) {
    console.error(`[mcp-session ${new Date().toISOString()}] ${msg}`);
  }
}

/** Extract the JSON-RPC method name(s) from a request body for logging. */
function methodOf(body: unknown): string {
  if (Array.isArray(body)) {
    return body.map((m) => (m as any)?.method ?? "?").join(",");
  }
  return (body as any)?.method ?? (body === undefined ? "(stream)" : "?");
}

export function makeHandler(args: {
  createTransport: TransportFactory;
  path: string;
  token?: string;
}): ((req: IncomingMessage, res: ServerResponse, body?: unknown) => void) & {
  closeAll: () => Promise<void>;
} {
  const { createTransport, path, token } = args;
  const sessions = new Map<string, TransportLike>();

  const handler = (
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): void => {
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

    // 3. Session routing.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    const delegate = (transport: TransportLike) => {
      void Promise.resolve(transport.handleRequest(req, res, body)).catch(
        (err) => {
          console.error(
            `HTTP transport handleRequest error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (!res.headersSent) {
            sendJsonRpcError(res, 500, -32603, "Internal server error");
          }
        },
      );
    };

    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        // Unknown session id: instruct the client to start a new session.
        debugLog(
          `UNKNOWN session=${sessionId} ${req.method} method=${methodOf(body)} → 404 (client will re-initialize)`,
        );
        sendJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      debugLog(
        `ROUTE   session=${sessionId} ${req.method} method=${methodOf(body)}`,
      );
      delegate(transport);
      return;
    }

    if (isInitializeRequest(body)) {
      // New session: build a fresh transport + server pair so a second
      // initialize (reconnecting client) never hits an already-initialized
      // server instance.
      debugLog(
        `INIT    new session requested (${req.socket?.remoteAddress ?? "?"}), active=${sessions.size}`,
      );
      let transportRef: TransportLike | undefined;
      void Promise.resolve(
        createTransport({
          onsessioninitialized: (id) => {
            if (transportRef) sessions.set(id, transportRef);
            debugLog(`OPEN    session=${id}, active=${sessions.size}`);
          },
        }),
      )
        .then((transport) => {
          transportRef = transport;
          transport.onclose = () => {
            if (transport.sessionId) {
              sessions.delete(transport.sessionId);
              debugLog(
                `CLOSE   session=${transport.sessionId}, active=${sessions.size}`,
              );
            }
          };
          delegate(transport);
        })
        .catch((err) => {
          console.error(
            `Failed to create MCP transport: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (!res.headersSent) {
            sendJsonRpcError(res, 500, -32603, "Internal server error");
          }
        });
      return;
    }

    // No session header on a non-initialize request: malformed.
    debugLog(
      `REJECT  no session id, method=${methodOf(body)} → 400 (session required)`,
    );
    sendJsonRpcError(res, 400, -32000, "Bad Request: Session ID required");
  };

  handler.closeAll = async (): Promise<void> => {
    const all = [...sessions.values()];
    debugLog(`SHUTDOWN closing ${all.length} session(s)`);
    sessions.clear();
    await Promise.allSettled(all.map((t) => t.close()));
  };

  return handler;
}

function isLocalhost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
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
 * Start the MCP server over Streamable HTTP. Resolves config from env and
 * listens on a node:http server. Each MCP session gets its own
 * StreamableHTTPServerTransport + McpServer pair, stored in a session map
 * keyed by Mcp-Session-Id (see makeHandler).
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

  const createTransport: TransportFactory = async ({
    onsessioninitialized,
  }) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: local,
      allowedHosts,
      onsessioninitialized,
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
    // StreamableHTTPServerTransport parses GET/DELETE itself; for POST we
    // must hand it the parsed body since we consumed the stream for routing.
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
    `opencode-mcp v1.11.0 started (HTTP transport on ` +
      `http://${cfg.host}:${cfg.port}${cfg.path} | OpenCode server at ${baseUrl})`,
  );

  const shutdown = () => {
    void handler.closeAll();
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
