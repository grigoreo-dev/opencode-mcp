#!/usr/bin/env node

/**
 * OpenCode MCP Server
 *
 * An MCP (Model Context Protocol) server that wraps the OpenCode AI headless
 * server HTTP API. This allows any MCP client to interact with a running
 * OpenCode instance — manage sessions, send prompts, search files, configure
 * providers, and more.
 *
 * Features:
 *  - 80 tools covering the entire OpenCode API surface
 *  - High-level workflow tools (opencode_ask, opencode_reply, etc.)
 *  - Smart response formatting for LLM-friendly output
 *  - MCP Resources for browseable project data
 *  - MCP Prompts for guided workflows
 *  - SSE event polling
 *  - TUI control tools
 *  - Retry logic with exponential backoff
 *  - Auto-detection and auto-start of the OpenCode server
 *
 * Environment variables:
 *   OPENCODE_BASE_URL        - Base URL of the OpenCode server (default: http://127.0.0.1:4096)
 *   OPENCODE_SERVER_USERNAME  - Username for HTTP basic auth (default: opencode)
 *   OPENCODE_SERVER_PASSWORD  - Password for HTTP basic auth (optional)
 *   OPENCODE_AUTO_SERVE       - Set to "false" to disable auto-start (default: true)
 *   OPENCODE_DEFAULT_PROVIDER - Default provider ID when not specified per-tool (optional)
 *   OPENCODE_DEFAULT_MODEL    - Default model ID when not specified per-tool (optional)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenCodeClient } from "./client.js";
import { ensureServer } from "./server-manager.js";
import { setModelDefaults } from "./helpers.js";
import { createServer } from "./server.js";

const baseUrl =
  process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const autoServe = process.env.OPENCODE_AUTO_SERVE !== "false";
const defaultProvider = process.env.OPENCODE_DEFAULT_PROVIDER;
const defaultModel = process.env.OPENCODE_DEFAULT_MODEL;

// Set global model defaults from env vars (used by applyModelDefaults() in tools)
setModelDefaults(defaultProvider, defaultModel);

const client = new OpenCodeClient({ baseUrl, username, password, autoServe });

const server = createServer(client);

// ── Start ───────────────────────────────────────────────────────────
async function main() {
  // Step 1: Ensure OpenCode server is available (auto-start if needed).
  try {
    await ensureServer({ baseUrl, autoServe, username, password });
  } catch (err) {
    // Log the error but don't prevent MCP from starting — tools will
    // report connection errors individually, and the server may come
    // up later.
    console.error(
      `Warning: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 2: Connect the MCP transport.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const defaultsInfo = defaultProvider && defaultModel
    ? ` | defaults: ${defaultProvider}/${defaultModel}`
    : "";
  console.error(
    `opencode-mcp v1.11.0 started (OpenCode server at ${baseUrl}${defaultsInfo})`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting opencode-mcp:", err);
  process.exit(1);
});
