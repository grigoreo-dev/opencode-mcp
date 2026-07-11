import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenCodeClient } from "./client.js";

// Tool groups
import { registerGlobalTools } from "./tools/global.js";
import { registerConfigTools } from "./tools/config.js";
import { registerProjectTools } from "./tools/project.js";
import { registerSessionTools } from "./tools/session.js";
import { registerMessageTools } from "./tools/message.js";
import { registerFileTools } from "./tools/file.js";
import { registerProviderTools } from "./tools/provider.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerTuiTools } from "./tools/tui.js";
import { registerEventTools } from "./tools/events.js";

// Resources and prompts
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

/**
 * Build the fully-wired McpServer (tools, resources, prompts) for a given
 * OpenCode client. Shared by both the stdio and HTTP transports so they
 * expose an identical server.
 */
export function createServer(client: OpenCodeClient): McpServer {
  const defaultProvider = process.env.OPENCODE_DEFAULT_PROVIDER;
  const defaultModel = process.env.OPENCODE_DEFAULT_MODEL;
  // Use env-var defaults in instruction examples; fall back to generic placeholders
  const exProvider = defaultProvider || "<your-provider>";
  const exModel = defaultModel || "<your-model>";

  const server = new McpServer(
    {
      name: "opencode-mcp",
      version: "1.11.0",
      description:
        "MCP server wrapping the OpenCode AI coding agent. " +
        "Delegates complex coding tasks (build apps, refactor, debug) to an autonomous AI agent. " +
        "Start with opencode_setup, then use opencode_ask for simple tasks, opencode_run for complex tasks, or opencode_fire for long-running background work.",
    },
    {
      instructions: [
        "# OpenCode MCP — Guide for LLM Clients",
        "",
        "You are connected to OpenCode, an autonomous AI coding agent that can build, edit, and debug software projects.",
        "This server exposes ~80 tools organized into tiers. Use high-level tools first; drop to low-level only when needed.",
        "",
        "## Getting Started (First Time)",
        "1. Call `opencode_setup` — checks server health, shows configured providers, and suggests next steps.",
        "2. Pick a provider from the **Ready to use** list returned by `opencode_setup`, then call `opencode_provider_models` to see its models.",
        "3. IMPORTANT: Always pass `providerID` and `modelID` from the discovered providers when sending prompts, or you may get empty responses. Do NOT assume any specific provider is available — always discover first.",
        "",
        "## Tool Tiers (prefer higher tiers)",
        "",
        "### Tier 1 — Essential (use these first)",
        "- `opencode_setup` — first-time onboarding, health check (read-only)",
        "- `opencode_ask` — one-shot question/task, creates session + gets response in one call. Simplest way to use OpenCode.",
        "- `opencode_reply` — continue a conversation in an existing session",
        "- `opencode_context` — get project info (path, git branch, config, agents) (read-only)",
        "",
        "### Tier 2 — Async Tasks (for complex/long work)",
        "- `opencode_run` — RECOMMENDED: send a task and wait for completion in one call. Creates session, sends prompt, polls until done. Best for tasks under 10 minutes.",
        "- `opencode_fire` — fire-and-forget: send a task and return immediately. Use `opencode_check` to monitor progress. Best for long tasks (10+ min).",
        "- `opencode_check` — cheap progress report: status, todos, file counts. Use to monitor sessions from `opencode_fire`. (read-only)",
        "- `opencode_wait` — block until a session finishes processing. Use after `opencode_message_send_async`. Has timeout.",
        "- `opencode_session_todo` — see the agent's internal task list for a session (read-only)",
        "",
        "### Tier 3 — Monitoring & Review",
        "- `opencode_review_changes` — see all file diffs from a session (read-only)",
        "- `opencode_conversation` — get full message history (read-only)",
        "- `opencode_sessions_overview` — list all sessions with status (read-only)",
        "- `opencode_provider_models` — list models for a specific provider (read-only)",
        "- `opencode_status` — quick server health dashboard (read-only)",
        "",
        "### Tier 4 — Fine-Grained Control",
        "- `opencode_session_*` — create, delete, fork, abort, share sessions",
        "- `opencode_message_*` — send messages, list history, execute commands",
        "- `opencode_permission_list` / `opencode_session_permission` — check and respond to permission requests",
        "- `opencode_file_*` / `opencode_find_*` — search files, read content, check VCS status",
        "- `opencode_provider_*` — manage providers, auth, OAuth flows",
        "",
        "### Tier 5 — Specialist (rarely needed)",
        "- `opencode_tui_*` — control the terminal UI (only if a TUI is running)",
        "- `opencode_events_poll` — poll raw SSE events",
        "- `opencode_mcp_*` — manage MCP servers inside OpenCode",
        "- `opencode_instance_dispose` — shut down the server (DESTRUCTIVE!)",
        "",
        "## Recommended Workflows",
        "",
        "### Quick question or small task:",
        "```",
        `opencode_ask({prompt: "How does auth work in this project?", providerID: "${exProvider}", modelID: "${exModel}"})`,
        "```",
        "",
        "### Complex multi-step task (build an app, refactor code, etc.):",
        "```",
        "// Option A: One-call (recommended for tasks under 10 min)",
        `opencode_run({prompt: "Build a React login form with validation...", providerID: "${exProvider}", modelID: "${exModel}", maxDurationSeconds: 600})`,
        "",
        "// Option B: Fire-and-forget (for longer tasks)",
        `opencode_fire({prompt: "Build a full React app with auth, dashboard...", providerID: "${exProvider}", modelID: "${exModel}"})`,
        "// ... do other work ...",
        'opencode_check({sessionId: "ses_xxx"})  // quick progress check',
        'opencode_review_changes({sessionId: "ses_xxx"})  // see changes after completion',
        "```",
        "",
        "### Continue working on an existing session:",
        "```",
        `opencode_reply({sessionId: "ses_xxx", prompt: "Now add form validation", providerID: "${exProvider}", modelID: "${exModel}"})`,
        "```",
        "",
        "## Permissions",
        "OpenCode may pause a session to ask for permission (e.g. to run a shell command or access files outside the project).",
        "- **Recommended for headless/automation:** Set `\"permission\": \"allow\"` in `opencode.json` to auto-approve all operations. Without this, sessions can block waiting for approval.",
        "- **If a session seems stuck:** Call `opencode_permission_list` to check for pending permission requests, then respond with `opencode_session_permission`.",
        "- You can also set permissions at runtime: `opencode_config_update({config: {permission: \"allow\"}})`",
        "",
        "## Important Notes",
        "- ALWAYS specify `providerID` and `modelID` when using `opencode_ask`, `opencode_reply`, `opencode_message_send`, or `opencode_message_send_async`. Without these, the agent may return empty responses. Use providers and models discovered via `opencode_setup` — do NOT hardcode any specific provider. If `OPENCODE_DEFAULT_PROVIDER` and `OPENCODE_DEFAULT_MODEL` env vars are set, they will be used as fallbacks when you don't specify them.",
        "- The `directory` parameter on every tool targets a specific project. Omit it to use the server's default project. Must be an absolute path to an existing directory — relative paths and non-existent paths are rejected with a helpful error.",
        "- Tools marked with `readOnlyHint: true` in their annotations are safe and don't modify state.",
        "- Tools marked with `destructiveHint: true` (`opencode_instance_dispose`, `opencode_session_delete`) permanently delete data — confirm with the user before calling.",
        "- `opencode_wait` sends `notifications/message` progress updates while blocking. If it times out, it returns a progress report instead of failing.",
        "- For tasks under 10 minutes, prefer `opencode_run` (one call, handles everything). For longer tasks, use `opencode_fire` + `opencode_check`.",
        "- For very long tasks, use `opencode_fire` + periodically call `opencode_check` or `opencode_session_todo` to monitor progress.",
      ].join("\n"),
    },
  );

  // ── Low-level API tools ─────────────────────────────────────────────
  registerGlobalTools(server, client);
  registerConfigTools(server, client);
  registerProjectTools(server, client);
  registerSessionTools(server, client);
  registerMessageTools(server, client);
  registerFileTools(server, client);
  registerProviderTools(server, client);
  registerMiscTools(server, client);

  // ── High-level workflow tools ───────────────────────────────────────
  registerWorkflowTools(server, client);

  // ── TUI control ─────────────────────────────────────────────────────
  registerTuiTools(server, client);

  // ── Event streaming ─────────────────────────────────────────────────
  registerEventTools(server, client);

  // ── Resources ───────────────────────────────────────────────────────
  registerResources(server, client);

  // ── Prompts ─────────────────────────────────────────────────────────
  registerPrompts(server);

  return server;
}
