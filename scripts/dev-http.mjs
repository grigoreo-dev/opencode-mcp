#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { parseArgs, buildChildEnv, usage } from "./dev-http-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distEntry = join(root, "dist", "index.js");
const envPath = join(root, ".env");

let fileEnv = {};
if (existsSync(envPath)) {
  fileEnv = parse(readFileSync(envPath, "utf8"));
}

let flags;
try {
  flags = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const { env, error } = buildChildEnv({
  fileEnv,
  processEnv: process.env,
  flags,
});

if (error) {
  console.error(error);
  console.error("\n" + usage());
  process.exit(1);
}

if (!existsSync(distEntry)) {
  console.error(`dev:http: missing ${distEntry}. Run: npm run build`);
  process.exit(1);
}

const child = spawn(process.execPath, [distEntry], {
  env,
  stdio: "inherit",
  cwd: root,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(`dev:http: failed to start: ${err.message}`);
  process.exit(1);
});
