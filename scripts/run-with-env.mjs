#!/usr/bin/env node
/**
 * Wrapper that injects WS_URL, WS_USER, WS_PASSWORD as env when spawning the MCP.
 * Use when Cursor does not pass mcp.json env to the spawned process.
 * Credentials stay in mcp.json as args to this wrapper.
 *
 * Usage: node run-with-env.mjs [--url WS_URL] [--user U] [--password P] [--stdio] -- <entry> [args...]
 *   e.g. node run-with-env.mjs --url "wss://host/...?appId=xxx" --user u --password p -- npx -y tsx src/index.ts
 */
import { spawn } from "child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const before = sep >= 0 ? argv.slice(0, sep) : argv;
const after = sep >= 0 ? argv.slice(sep + 1) : [];

let WS_URL, WS_USER, WS_PASSWORD, MCP_TRANSPORT, OUTPUT_TO_CURSOR_DEBUG_LOG, DEBUG_LOG_FILE;
for (let i = 0; i < before.length; i++) {
  const arg = before[i];
  const next = before[i + 1];
  if ((arg === "--url" || arg === "-u") && next) {
    WS_URL = next;
    i++;
  } else if ((arg === "--user" || arg === "--username") && next) {
    WS_USER = next;
    i++;
  } else if ((arg === "--password" || arg === "-p") && next) {
    WS_PASSWORD = next;
    i++;
  } else if (arg === "--stdio") {
    MCP_TRANSPORT = "stdio";
  } else if (arg === "--output-debug-log" && next) {
    OUTPUT_TO_CURSOR_DEBUG_LOG = next;
    i++;
  } else if (arg === "--debug-file" && next) {
    DEBUG_LOG_FILE = next;
    i++;
  }
}

const missing = [];
if (!WS_URL) missing.push("--url");
if (!WS_USER) missing.push("--user");
if (!WS_PASSWORD) missing.push("--password");
if (missing.length > 0) {
  console.error("Missing: " + missing.join(", "));
  process.exit(1);
}

const [entry, ...args] = after;
if (!entry) {
  console.error("Usage: node run-with-env.mjs --url X --user U --password P -- <entry> [args...]");
  process.exit(1);
}

const env = {
  ...process.env,
  WS_URL,
  WS_USER,
  WS_PASSWORD,
  ...(MCP_TRANSPORT && { MCP_TRANSPORT }),
  ...(OUTPUT_TO_CURSOR_DEBUG_LOG && { OUTPUT_TO_CURSOR_DEBUG_LOG }),
  ...(DEBUG_LOG_FILE && { DEBUG_LOG_FILE }),
};

const child = spawn(entry, args, {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
child.on("exit", (code) => process.exit(code ?? 0));
