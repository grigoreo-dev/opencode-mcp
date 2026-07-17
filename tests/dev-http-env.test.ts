import { describe, it, expect } from "vitest";
import { parseArgs, buildChildEnv, usage } from "../scripts/dev-http-env.mjs";

describe("parseArgs", () => {
  it("parses host port path insecure", () => {
    expect(
      parseArgs(["--host", "0.0.0.0", "--port", "3001", "--path", "/rpc", "--insecure"]),
    ).toEqual({
      host: "0.0.0.0",
      port: "3001",
      path: "/rpc",
      insecure: true,
    });
  });

  it("defaults insecure false and omits unset flags", () => {
    expect(parseArgs([])).toEqual({ insecure: false });
  });

  it("throws on unknown flag", () => {
    expect(() => parseArgs(["--token", "x"])).toThrow(/unknown/i);
  });

  it("throws when --host missing value", () => {
    expect(() => parseArgs(["--host"])).toThrow(/--host/);
  });

  it("throws on invalid port", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(/port/i);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/port/i);
  });
});

describe("buildChildEnv", () => {
  const baseProcess = {
    PATH: "/usr/bin",
    HOME: "/home/u",
  } as NodeJS.ProcessEnv;

  it("loads token from fileEnv and enables http transport with auth", () => {
    const { env, error } = buildChildEnv({
      fileEnv: { OPENCODE_MCP_HTTP_TOKEN: "secret" },
      processEnv: { ...baseProcess },
      flags: { insecure: false },
    });
    expect(error).toBeUndefined();
    expect(env.OPENCODE_MCP_TRANSPORT).toBe("http");
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBe("secret");
    expect(env.OPENCODE_MCP_HTTP_INSECURE).toBeUndefined();
  });

  it("does not let fileEnv override existing processEnv", () => {
    const { env } = buildChildEnv({
      fileEnv: {
        OPENCODE_MCP_HTTP_TOKEN: "from-file",
        OPENCODE_MCP_HTTP_HOST: "127.0.0.1",
      },
      processEnv: {
        ...baseProcess,
        OPENCODE_MCP_HTTP_TOKEN: "from-process",
        OPENCODE_MCP_HTTP_HOST: "10.0.0.1",
      },
      flags: { insecure: false },
    });
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBe("from-process");
    expect(env.OPENCODE_MCP_HTTP_HOST).toBe("10.0.0.1");
  });

  it("lets CLI override host/port/path over process and file", () => {
    const { env } = buildChildEnv({
      fileEnv: {
        OPENCODE_MCP_HTTP_TOKEN: "t",
        OPENCODE_MCP_HTTP_HOST: "file-host",
        OPENCODE_MCP_HTTP_PORT: "3000",
        OPENCODE_MCP_HTTP_PATH: "/file",
      },
      processEnv: {
        ...baseProcess,
        OPENCODE_MCP_HTTP_HOST: "proc-host",
        OPENCODE_MCP_HTTP_PORT: "3001",
        OPENCODE_MCP_HTTP_PATH: "/proc",
      },
      flags: {
        host: "0.0.0.0",
        port: "4000",
        path: "/mcp",
        insecure: false,
      },
    });
    expect(env.OPENCODE_MCP_HTTP_HOST).toBe("0.0.0.0");
    expect(env.OPENCODE_MCP_HTTP_PORT).toBe("4000");
    expect(env.OPENCODE_MCP_HTTP_PATH).toBe("/mcp");
  });

  it("clears insecure when token is present even if process had insecure", () => {
    const { env } = buildChildEnv({
      fileEnv: { OPENCODE_MCP_HTTP_TOKEN: "t" },
      processEnv: {
        ...baseProcess,
        OPENCODE_MCP_HTTP_INSECURE: "true",
      },
      flags: { insecure: true },
    });
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBe("t");
    expect(env.OPENCODE_MCP_HTTP_INSECURE).toBeUndefined();
  });

  it("allows --insecure without token", () => {
    const { env, error } = buildChildEnv({
      fileEnv: {},
      processEnv: { ...baseProcess },
      flags: { insecure: true },
    });
    expect(error).toBeUndefined();
    expect(env.OPENCODE_MCP_TRANSPORT).toBe("http");
    expect(env.OPENCODE_MCP_HTTP_INSECURE).toBe("true");
    expect(env.OPENCODE_MCP_HTTP_TOKEN).toBeUndefined();
  });

  it("errors without token and without insecure", () => {
    const { error } = buildChildEnv({
      fileEnv: {},
      processEnv: { ...baseProcess },
      flags: { insecure: false },
    });
    expect(error).toMatch(/OPENCODE_MCP_HTTP_TOKEN is required/);
    expect(error).toMatch(/--insecure/);
  });
});

describe("usage", () => {
  it("mentions flags and .env token, not a sample secret", () => {
    const u = usage();
    expect(u).toMatch(/--host/);
    expect(u).toMatch(/OPENCODE_MCP_HTTP_TOKEN/);
    expect(u).not.toMatch(/secret|sk-/i);
  });
});
