import { describe, it, expect, vi } from "vitest";

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: vi.fn(),
  OpencodeClient: vi.fn(),
}));

import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("returns an McpServer-like object with a connect method", () => {
    const fakeClient = {} as any;
    const server = createServer(fakeClient);
    expect(server).toBeTruthy();
    expect(typeof (server as any).connect).toBe("function");
  });

  it("does not throw while registering tools/resources/prompts", () => {
    const fakeClient = {} as any;
    expect(() => createServer(fakeClient)).not.toThrow();
  });
});
