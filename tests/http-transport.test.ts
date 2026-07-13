import { describe, it, expect, vi } from "vitest";
import { resolveHttpConfig } from "../src/http-transport.js";
import { makeHandler } from "../src/http-transport.js";

function mockReq(method: string, url: string, headers: Record<string, string> = {}) {
  return { method, url, headers, socket: { remoteAddress: "10.0.0.1" } } as any;
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

/**
 * Mock per-request transport factory for stateless tests. Each call
 * produces a transport that records handleRequest args and can be told
 * to reject.
 */
function mockTransportFactory() {
  const created: any[] = [];
  const factory = vi.fn(() => {
    const transport: any = {
      handleRequest: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    created.push(transport);
    return transport;
  });
  return { factory, created };
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

describe("makeHandler (stateless per-request)", () => {
  it("returns 404 JSON-RPC for a non-matching path and creates no transport", async () => {
    const { factory } = mockTransportFactory();
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "t" });
    const res = mockRes();
    handler(mockReq("POST", "/wrong", { authorization: "Bearer t" }), res, { jsonrpc: "2.0", method: "tools/list", id: 1 });
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: "2.0", id: null });
    expect(JSON.parse(res.body).error.code).toBe(-32001);
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns 401 when token is set and Authorization is missing/wrong", async () => {
    const { factory } = mockTransportFactory();
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const res = mockRes();
    handler(mockReq("POST", "/mcp", { authorization: "Bearer nope" }), res, { jsonrpc: "2.0", method: "tools/list", id: 1 });
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
    expect(factory).not.toHaveBeenCalled();
  });

  it("creates a fresh transport per request and delegates with body", async () => {
    const { factory, created } = mockTransportFactory();
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const body = { jsonrpc: "2.0", method: "tools/list", id: 1 };
    const req = mockReq("POST", "/mcp", { authorization: "Bearer secret" });
    const res = mockRes();
    handler(req, res, body);
    await new Promise((r) => setImmediate(r));
    expect(factory).toHaveBeenCalledOnce();
    expect(created[0].handleRequest).toHaveBeenCalledWith(req, res, body);
  });

  it("two consecutive initialize requests both succeed with separate transports", async () => {
    const { factory, created } = mockTransportFactory();
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const init = { jsonrpc: "2.0", method: "initialize", params: {}, id: 1 };

    handler(mockReq("POST", "/mcp", { authorization: "Bearer secret" }), mockRes(), init);
    await new Promise((r) => setImmediate(r));
    handler(mockReq("POST", "/mcp", { authorization: "Bearer secret" }), mockRes(), init);
    await new Promise((r) => setImmediate(r));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(created[0].handleRequest).toHaveBeenCalledOnce();
    expect(created[1].handleRequest).toHaveBeenCalledOnce();
  });

  it("requests with a stale mcp-session-id are still served (stateless ignores it)", async () => {
    const { factory, created } = mockTransportFactory();
    const handler = makeHandler({ createTransport: factory, path: "/mcp", token: "secret" });
    const res = mockRes();
    handler(
      mockReq("POST", "/mcp", { authorization: "Bearer secret", "mcp-session-id": "ghost" }),
      res,
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
    );
    await new Promise((r) => setImmediate(r));
    expect(factory).toHaveBeenCalledOnce();
    expect(created[0].handleRequest).toHaveBeenCalled();
  });

  it("delegates without auth when no token configured (insecure)", async () => {
    const { factory, created } = mockTransportFactory();
    const handler = makeHandler({ createTransport: factory, path: "/mcp" });
    const req = mockReq("GET", "/mcp");
    const res = mockRes();
    handler(req, res, undefined);
    await new Promise((r) => setImmediate(r));
    expect(created[0].handleRequest).toHaveBeenCalledWith(req, res, undefined);
  });

  it("matches path even when a query string is present", async () => {
    const { factory, created } = mockTransportFactory();
    const handler = makeHandler({ createTransport: factory, path: "/mcp" });
    handler(mockReq("POST", "/mcp?foo=bar"), mockRes(), { jsonrpc: "2.0", method: "x", id: 1 });
    await new Promise((r) => setImmediate(r));
    expect(created[0].handleRequest).toHaveBeenCalled();
  });

  it("returns 500 JSON-RPC when handleRequest rejects (headers not sent)", async () => {
    const factory = vi.fn(() => ({
      handleRequest: vi.fn().mockRejectedValue(new Error("boom")),
      close: vi.fn(),
    }));
    const handler = makeHandler({ createTransport: factory as any, path: "/mcp" });
    const res = mockRes();
    handler(mockReq("POST", "/mcp"), res, { jsonrpc: "2.0", method: "x", id: 1 });
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe(-32603);
  });

  it("returns 500 when the transport factory itself rejects", async () => {
    const factory = vi.fn(() => Promise.reject(new Error("factory boom")));
    const handler = makeHandler({ createTransport: factory as any, path: "/mcp" });
    const res = mockRes();
    handler(mockReq("POST", "/mcp"), res, { jsonrpc: "2.0", method: "x", id: 1 });
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe(-32603);
  });

  it("logs request handling to stderr when OPENCODE_MCP_DEBUG=true", async () => {
    const prev = process.env.OPENCODE_MCP_DEBUG;
    process.env.OPENCODE_MCP_DEBUG = "true";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { factory } = mockTransportFactory();
      const handler = makeHandler({ createTransport: factory, path: "/mcp" });
      handler(mockReq("POST", "/mcp", {}), mockRes(), { jsonrpc: "2.0", method: "tools/call", id: 1 });
      await new Promise((r) => setImmediate(r));
      const logs = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toMatch(/REQ\s+POST method=tools\/call/);
    } finally {
      errSpy.mockRestore();
      if (prev === undefined) delete process.env.OPENCODE_MCP_DEBUG;
      else process.env.OPENCODE_MCP_DEBUG = prev;
    }
  });

  it("does not log when OPENCODE_MCP_DEBUG is not set", async () => {
    const prev = process.env.OPENCODE_MCP_DEBUG;
    delete process.env.OPENCODE_MCP_DEBUG;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { factory } = mockTransportFactory();
      const handler = makeHandler({ createTransport: factory, path: "/mcp" });
      handler(mockReq("POST", "/mcp", {}), mockRes(), { jsonrpc: "2.0", method: "tools/list", id: 1 });
      await new Promise((r) => setImmediate(r));
      const logs = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).not.toMatch(/\[mcp-http/);
    } finally {
      errSpy.mockRestore();
      if (prev !== undefined) process.env.OPENCODE_MCP_DEBUG = prev;
    }
  });
});
