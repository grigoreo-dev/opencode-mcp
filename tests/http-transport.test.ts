import { describe, it, expect, vi } from "vitest";
import { resolveHttpConfig } from "../src/http-transport.js";
import { makeHandler } from "../src/http-transport.js";

function mockReq(method: string, url: string, headers: Record<string, string> = {}) {
  return { method, url, headers } as any;
}
function mockRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    headersSent: false,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    writeHead(code: number) { this.statusCode = code; return this; },
    end(chunk?: string) { if (chunk) this.body += chunk; },
  };
  return res;
}

describe("resolveHttpConfig", () => {
  it("throws when no token and not insecure", () => {
    expect(() => resolveHttpConfig({})).toThrow(/OPENCODE_MCP_HTTP_TOKEN/);
  });

  it("returns config with token when token set", () => {
    const cfg = resolveHttpConfig({ OPENCODE_MCP_HTTP_TOKEN: "secret" });
    expect(cfg.token).toBe("secret");
    expect(cfg.insecure).toBe(false);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3000);
    expect(cfg.path).toBe("/mcp");
  });

  it("allows no token when insecure=true and warns", () => {
    const warn = vi.fn();
    const cfg = resolveHttpConfig({ OPENCODE_MCP_HTTP_INSECURE: "true" }, warn);
    expect(cfg.token).toBeUndefined();
    expect(cfg.insecure).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/insecure|auth disabled/i);
  });

  it("honors custom port/host/path", () => {
    const cfg = resolveHttpConfig({
      OPENCODE_MCP_HTTP_TOKEN: "t",
      OPENCODE_MCP_HTTP_PORT: "8080",
      OPENCODE_MCP_HTTP_HOST: "0.0.0.0",
      OPENCODE_MCP_HTTP_PATH: "/rpc",
    });
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.path).toBe("/rpc");
  });

  it("normalizes a path without leading slash", () => {
    const cfg = resolveHttpConfig({ OPENCODE_MCP_HTTP_TOKEN: "t", OPENCODE_MCP_HTTP_PATH: "mcp" });
    expect(cfg.path).toBe("/mcp");
  });

  it("throws on a non-numeric port", () => {
    expect(() =>
      resolveHttpConfig({ OPENCODE_MCP_HTTP_TOKEN: "t", OPENCODE_MCP_HTTP_PORT: "abc" }),
    ).toThrow(/OPENCODE_MCP_HTTP_PORT/);
  });
  it("throws on an out-of-range port", () => {
    expect(() =>
      resolveHttpConfig({ OPENCODE_MCP_HTTP_TOKEN: "t", OPENCODE_MCP_HTTP_PORT: "70000" }),
    ).toThrow(/OPENCODE_MCP_HTTP_PORT/);
  });
});

/**
 * Build a mock transport factory for session-map tests. Each created
 * transport records handleRequest calls, exposes onclose, and simulates
 * session initialization by invoking onsessioninitialized with the next
 * id from `ids` on the first handleRequest (like the real
 * StreamableHTTPServerTransport does during an initialize round-trip).
 */
function mockTransportFactory(ids: string[]) {
  const created: any[] = [];
  let idIdx = 0;
  const factory = vi.fn((opts: { onsessioninitialized?: (id: string) => void }) => {
    const transport: any = {
      sessionId: undefined as string | undefined,
      onclose: undefined as undefined | (() => void),
      handleRequest: vi.fn().mockImplementation(async () => {
        if (transport.sessionId === undefined) {
          transport.sessionId = ids[idIdx++];
          opts.onsessioninitialized?.(transport.sessionId);
        }
      }),
      close: vi.fn().mockImplementation(() => {
        transport.onclose?.();
      }),
    };
    created.push(transport);
    return transport;
  });
  return { factory, created };
}

function initializeBody() {
  return {
    jsonrpc: "2.0",
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    id: 1,
  };
}

describe("makeHandler (session map)", () => {
  it("returns 404 JSON-RPC for a non-matching path and creates no transport", async () => {
    const { factory } = mockTransportFactory(["s1"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "t" });
    const res = mockRes();
    handler(mockReq("POST", "/wrong", { authorization: "Bearer t" }), res, initializeBody());
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns 401 when token is set and Authorization is missing/wrong", async () => {
    const { factory } = mockTransportFactory(["s1"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const res = mockRes();
    handler(mockReq("POST", "/mcp", { authorization: "Bearer nope" }), res, initializeBody());
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("creates a new transport for an initialize request without session id", async () => {
    const { factory, created } = mockTransportFactory(["s1"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const req = mockReq("POST", "/mcp", { authorization: "Bearer secret" });
    const res = mockRes();
    handler(req, res, initializeBody());
    await new Promise((r) => setImmediate(r));
    expect(factory).toHaveBeenCalledOnce();
    expect(created[0].handleRequest).toHaveBeenCalledWith(req, res, initializeBody());
  });

  it("creates a SECOND transport when a second initialize arrives (no 'already initialized' error)", async () => {
    const { factory, created } = mockTransportFactory(["s1", "s2"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });

    handler(mockReq("POST", "/mcp", { authorization: "Bearer secret" }), mockRes(), initializeBody());
    await new Promise((r) => setImmediate(r));
    handler(mockReq("POST", "/mcp", { authorization: "Bearer secret" }), mockRes(), initializeBody());
    await new Promise((r) => setImmediate(r));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(2);
    expect(created[0].handleRequest).toHaveBeenCalledOnce();
    expect(created[1].handleRequest).toHaveBeenCalledOnce();
  });

  it("routes a request with a known mcp-session-id to its own transport", async () => {
    const { factory, created } = mockTransportFactory(["s1"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });

    // establish session s1
    handler(mockReq("POST", "/mcp", { authorization: "Bearer secret" }), mockRes(), initializeBody());
    await new Promise((r) => setImmediate(r));

    // follow-up request carries the session header
    const followUp = mockReq("POST", "/mcp", { authorization: "Bearer secret", "mcp-session-id": "s1" });
    const res2 = mockRes();
    handler(followUp, res2, { jsonrpc: "2.0", method: "tools/list", id: 2 });
    await new Promise((r) => setImmediate(r));

    expect(factory).toHaveBeenCalledOnce(); // no new transport
    expect(created[0].handleRequest).toHaveBeenCalledTimes(2);
  });

  it("returns 404 for an unknown mcp-session-id", async () => {
    const { factory } = mockTransportFactory([]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const res = mockRes();
    handler(
      mockReq("POST", "/mcp", { authorization: "Bearer secret", "mcp-session-id": "ghost" }),
      res,
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
    );
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-initialize request without session id", async () => {
    const { factory } = mockTransportFactory([]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const res = mockRes();
    handler(
      mockReq("POST", "/mcp", { authorization: "Bearer secret" }),
      res,
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
    );
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32000);
    expect(factory).not.toHaveBeenCalled();
  });

  it("removes the session from the map when transport closes (404 afterwards)", async () => {
    const { factory, created } = mockTransportFactory(["s1"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });

    handler(mockReq("POST", "/mcp", { authorization: "Bearer secret" }), mockRes(), initializeBody());
    await new Promise((r) => setImmediate(r));

    created[0].close(); // triggers onclose → map cleanup

    const res = mockRes();
    handler(
      mockReq("POST", "/mcp", { authorization: "Bearer secret", "mcp-session-id": "s1" }),
      res,
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
    );
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(404);
  });

  it("returns 500 JSON-RPC when handleRequest rejects (headers not sent)", async () => {
    const { factory, created } = mockTransportFactory(["s1"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp" });
    // establish session
    handler(mockReq("POST", "/mcp", {}), mockRes(), initializeBody());
    await new Promise((r) => setImmediate(r));
    // make the transport reject on the follow-up
    created[0].handleRequest.mockRejectedValueOnce(new Error("boom"));
    const res = mockRes();
    handler(mockReq("POST", "/mcp", { "mcp-session-id": "s1" }), res, { jsonrpc: "2.0", method: "x", id: 3 });
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe(-32603);
  });

  it("GET request with a known session id is delegated (SSE stream)", async () => {
    const { factory, created } = mockTransportFactory(["s1"]);
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    handler(mockReq("POST", "/mcp", { authorization: "Bearer secret" }), mockRes(), initializeBody());
    await new Promise((r) => setImmediate(r));

    const getReq = mockReq("GET", "/mcp", { authorization: "Bearer secret", "mcp-session-id": "s1" });
    const res = mockRes();
    handler(getReq, res, undefined);
    await new Promise((r) => setImmediate(r));
    expect(created[0].handleRequest).toHaveBeenCalledTimes(2);
  });
});
