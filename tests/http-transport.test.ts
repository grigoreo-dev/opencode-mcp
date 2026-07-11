import { describe, it, expect, vi } from "vitest";
import { resolveHttpConfig } from "../src/http-transport.js";

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
});
