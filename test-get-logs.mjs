#!/usr/bin/env node
import { spawn } from "child_process";
import { createInterface } from "readline";

// Load .env manually for this test
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(join(__dir, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch (_) {}

const env = {
  ...process.env,
  MCP_TRANSPORT: "stdio",
  WS_URL:
    "wss://helium.mezzanineware.com/api/ws2/logging?appId=09a1e3ab-6219-4206-99fb-c5c68de47382",
  WS_USER: process.env.HELIUM_USER,
  WS_PASSWORD: process.env.HELIUM_PASSWORD,
};

const proc = spawn("node", ["build/index.js"], {
  cwd: __dir,
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");

let initDone = false;
let logsResult = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result) {
      initDone = true;
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_ws_logs", arguments: { lines: 50 } },
        });
      }, 300);
    } else if (msg.id === 2 && msg.result) {
      logsResult = msg.result;
      proc.kill("SIGTERM");
    }
  } catch (_) {}
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
});

proc.on("exit", () => {
  if (logsResult?.content) {
    console.log("\n--- get_ws_logs result (last 50 lines) ---\n");
    logsResult.content.forEach((c) => console.log(c.text));
    console.log("\n--- end ---");
  } else {
    console.log("No log content in response");
  }
  process.exit(0);
});

setTimeout(() => proc.kill("SIGTERM"), 8000);
