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

describe("makeHandler", () => {
  it("returns 404 JSON-RPC for a non-matching path and does not call transport", async () => {
    const transport = { handleRequest: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ transport, path: "/mcp", token: "t" });
    const res = mockRes();
    handler(mockReq("POST", "/wrong", { authorization: "Bearer t" }), res);
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: "2.0", id: null });
    expect(JSON.parse(res.body).error.code).toBe(-32001);
    expect(transport.handleRequest).not.toHaveBeenCalled();
  });

  it("returns 401 when token is set and Authorization is missing/wrong", async () => {
    const transport = { handleRequest: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ transport, path: "/mcp", token: "secret" });
    const res = mockRes();
    handler(mockReq("POST", "/mcp", { authorization: "Bearer nope" }), res);
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
    expect(transport.handleRequest).not.toHaveBeenCalled();
  });

  it("delegates to transport.handleRequest on valid path + valid Bearer", async () => {
    const transport = { handleRequest: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ transport, path: "/mcp", token: "secret" });
    const req = mockReq("POST", "/mcp", { authorization: "Bearer secret" });
    const res = mockRes();
    handler(req, res);
    await new Promise((r) => setImmediate(r));
    expect(transport.handleRequest).toHaveBeenCalledWith(req, res);
  });

  it("delegates without auth when no token configured (insecure)", async () => {
    const transport = { handleRequest: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ transport, path: "/mcp" });
    const req = mockReq("GET", "/mcp");
    const res = mockRes();
    handler(req, res);
    await new Promise((r) => setImmediate(r));
    expect(transport.handleRequest).toHaveBeenCalledWith(req, res);
  });

  it("matches path even when a query string is present", async () => {
    const transport = { handleRequest: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ transport, path: "/mcp" });
    const req = mockReq("POST", "/mcp?foo=bar");
    const res = mockRes();
    handler(req, res);
    await new Promise((r) => setImmediate(r));
    expect(transport.handleRequest).toHaveBeenCalled();
  });

  it("returns 500 JSON-RPC when transport.handleRequest rejects (headers not sent)", async () => {
    const transport = { handleRequest: vi.fn().mockRejectedValue(new Error("boom")) };
    const handler = makeHandler({ transport, path: "/mcp" });
    const res = mockRes();
    handler(mockReq("POST", "/mcp"), res);
    await new Promise((r) => setImmediate(r));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe(-32603);
  });
});
