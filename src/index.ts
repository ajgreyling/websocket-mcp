#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response } from "express";
import WebSocket from "ws";
import { z } from "zod";

const LOG_URI = "ws-log://logs";
const MAX_LOG_LINES = 10_000;
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const DEFAULT_PORT = 3000;

function parseArgs(): {
  url?: string;
  user?: string;
  password?: string;
  stdio?: boolean;
} {
  const out: { url?: string; user?: string; password?: string; stdio?: boolean } = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--stdio") {
      out.stdio = true;
    } else if ((arg === "--url" || arg === "-u") && next != null) {
      out.url = next;
      i++;
    } else if ((arg === "--user" || arg === "--username") && next != null) {
      out.user = next;
      i++;
    } else if ((arg === "--password" || arg === "-p") && next != null) {
      out.password = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs();

function getAuth(): { user: string; password: string } {
  const fromEnv = process.env.WS_USER != null && process.env.WS_PASSWORD != null;
  if (fromEnv) {
    return {
      user: process.env.WS_USER!,
      password: process.env.WS_PASSWORD!,
    };
  }
  if (args.user != null && args.password != null) {
    return { user: args.user, password: args.password };
  }
  const auth = process.env.WS_AUTH;
  if (auth) {
    const i = auth.indexOf(":");
    if (i === -1) {
      console.error("WS_AUTH must be in the form username:password");
      process.exit(1);
    }
    return { user: auth.slice(0, i), password: auth.slice(i + 1) };
  }
  const user = process.env.WS_USER;
  const password = process.env.WS_PASSWORD;
  if (!user || !password) {
    console.error(
      "Set WS_URL, WS_USER, WS_PASSWORD in mcp.json (as args: --url --user --password) or in env"
    );
    process.exit(1);
  }
  return { user, password };
}

const logLines: string[] = [];
const connectedServers = new Set<McpServer>();
const transportsBySessionId = new Map<string, SSEServerTransport>();

function appendLog(line: string): void {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) {
    logLines.splice(0, logLines.length - MAX_LOG_LINES);
  }
}

function getLogsText(tail?: number): string {
  const lines = tail != null ? logLines.slice(-tail) : logLines;
  return lines.join("\n");
}

function extractLineTimestamp(line: string): Date | null {
  // Status lines: [2026-02-13T12:45:18.651+02:00] WebSocket ...
  const bracketMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.+-]+)\]/);
  if (bracketMatch) {
    const d = new Date(bracketMatch[1]);
    if (!isNaN(d.getTime())) return d;
  }
  // Helium JSON lines: < {"millis": 123456789, ...}
  let jsonStr = line.trim();
  if (jsonStr.startsWith("< ")) jsonStr = jsonStr.slice(2);
  else if (jsonStr.startsWith("<")) jsonStr = jsonStr.slice(1);
  try {
    const obj = JSON.parse(jsonStr) as { millis?: unknown };
    if (typeof obj.millis === "number") return new Date(obj.millis);
  } catch {
    /* ignore */
  }
  return null;
}

function getLogsFiltered(opts: {
  last?: number;
  fromTime?: Date;
  toTime?: Date;
}): string {
  let lines: string[] = logLines;

  if (opts.fromTime != null || opts.toTime != null) {
    lines = lines.filter((line) => {
      const ts = extractLineTimestamp(line);
      if (ts == null) return false;
      if (opts.fromTime != null && ts < opts.fromTime) return false;
      if (opts.toTime != null && ts > opts.toTime) return false;
      return true;
    });
  }

  if (opts.last != null) {
    lines = lines.slice(-opts.last);
  }

  return lines.map(formatHeliumLogMessage).join("\n");
}

function formatLocalTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function formatHeliumLogMessage(rawText: string): string {
  let jsonStr = rawText.trim();
  if (jsonStr.startsWith("< ")) {
    jsonStr = jsonStr.slice(2);
  } else if (jsonStr.startsWith("<")) {
    jsonStr = jsonStr.slice(1);
  }
  try {
    const obj = JSON.parse(jsonStr) as {
      millis?: number;
      key?: string;
      value?: string;
    };
    const millis = obj.millis;
    const key = obj.key;
    const value = obj.value;
    if (
      millis != null &&
      typeof key === "string" &&
      typeof value === "string"
    ) {
      const ts = formatLocalTimestamp(new Date(millis));
      return `${ts} - ${key} - ${value}`;
    }
  } catch {
    /* fall through to raw */
  }
  return rawText;
}

function writeToDebugLogFile(line: string): void {
  if (process.env.OUTPUT_TO_CURSOR_DEBUG_LOG !== "true") return;
  const debugPath = process.env.DEBUG_LOG_FILE;
  if (!debugPath) return;
  try {
    const dir = path.dirname(debugPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(debugPath, line + "\n");
  } catch (err) {
    console.error("Failed to write to debug log file:", err);
  }
}

function connectWebSocket(
  url: string,
  auth: { user: string; password: string },
  onLogUpdate: () => void
): WebSocket {
  const encoded = Buffer.from(`${auth.user}:${auth.password}`).toString(
    "base64"
  );
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Basic ${encoded}`,
    },
  });

  ws.on("open", () => {
    const line = `[${formatLocalTimestamp(new Date())}] WebSocket connected`;
    appendLog(line);
    writeToDebugLogFile(line);
    onLogUpdate();
  });

  ws.on("message", (data: WebSocket.RawData) => {
    const text =
      typeof data === "string" ? data : (data as Buffer).toString("utf8");
    appendLog(text);
    writeToDebugLogFile(formatHeliumLogMessage(text));
    onLogUpdate();
  });

  ws.on("close", (code, reason) => {
    const line = `[${formatLocalTimestamp(new Date())}] WebSocket closed (code=${code} reason=${reason.toString()})`;
    appendLog(line);
    writeToDebugLogFile(line);
    onLogUpdate();
  });

  ws.on("error", (err) => {
    const line = `[${formatLocalTimestamp(new Date())}] WebSocket error: ${err.message}`;
    appendLog(line);
    writeToDebugLogFile(line);
    if (err.message.includes("401") && process.env.WS_URL) {
      const hint =
        "  (If 401 persists, verify credentials with: wscat -c \"<WS_URL>\" --auth \"<user>:<password>\")";
      appendLog(hint);
      writeToDebugLogFile(hint);
    }
    onLogUpdate();
  });

  return ws;
}

function startReconnectingWs(
  url: string,
  auth: { user: string; password: string },
  onLogUpdate: () => void
): void {
  let delay = INITIAL_RECONNECT_MS;

  function connect(): void {
    const ws = connectWebSocket(url, auth, onLogUpdate);
    ws.on("close", () => {
      const next = Math.min(delay, MAX_RECONNECT_MS);
      delay = Math.min(delay * 2, MAX_RECONNECT_MS);
      setTimeout(connect, next);
    });
    ws.on("open", () => {
      delay = INITIAL_RECONNECT_MS;
    });
  }

  connect();
}

function getWsUrl(): string {
  if (process.env.WS_URL != null && process.env.WS_URL !== "") {
    return process.env.WS_URL;
  }
  if (args.url != null && args.url !== "") {
    return args.url;
  }
  const url = process.env.WS_URL;
  if (!url) {
    console.error("Set WS_URL in mcp.json (as --url arg) or in env");
    process.exit(1);
  }
  return url;
}

function createMcpServer(): McpServer {
  const mcp = new McpServer(
    {
      name: "helium-rapid-websocket-mcp",
      version: "1.0.5",
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
      },
    }
  );

  mcp.registerResource(
    "logs",
    LOG_URI,
    {
      description: "Live logs from Helium logging WebSocket",
      mimeType: "text/plain",
    },
    () => ({
      contents: [
        {
          uri: LOG_URI,
          mimeType: "text/plain",
          text: getLogsText(),
        },
      ],
    })
  );

  mcp.registerTool(
    "get_ws_logs",
    {
      description:
        "Return WebSocket log entries. Filter by a time range (from_time / to_time) and/or limit to the last N rows. " +
        "All parameters are optional and can be combined. Timestamps must be ISO 8601 (e.g. '2026-03-13T08:00:00+02:00'). " +
        "When no time filter is given, all buffered entries are returned (up to the last N if 'lines' is set).",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_LINES)
          .optional()
          .describe("Return only the last N rows (applied after any time filter)"),
        from_time: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp — return entries at or after this time"),
        to_time: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp — return entries at or before this time"),
      }),
    },
    ({ lines, from_time, to_time }) => {
      const fromTime = from_time != null ? new Date(from_time) : undefined;
      const toTime = to_time != null ? new Date(to_time) : undefined;

      if (fromTime != null && isNaN(fromTime.getTime())) {
        return {
          content: [{ type: "text" as const, text: `Invalid from_time: "${from_time}"` }],
          isError: true,
        };
      }
      if (toTime != null && isNaN(toTime.getTime())) {
        return {
          content: [{ type: "text" as const, text: `Invalid to_time: "${to_time}"` }],
          isError: true,
        };
      }

      const useFilter = fromTime != null || toTime != null || lines != null;
      const text = useFilter
        ? getLogsFiltered({ last: lines, fromTime, toTime })
        : getLogsText();

      return { content: [{ type: "text" as const, text }] };
    }
  );

  return mcp;
}

function notifyLogsUpdated(): void {
  for (const mcp of connectedServers) {
    if (mcp.isConnected()) {
      mcp.server.sendResourceUpdated({ uri: LOG_URI }).catch(() => {});
    }
  }
}

async function runStdioMode(url: string, auth: { user: string; password: string }): Promise<void> {
  const transport = new StdioServerTransport();
  const mcp = createMcpServer();
  connectedServers.add(mcp);
  await mcp.connect(transport);
  startReconnectingWs(url, auth, notifyLogsUpdated);
}

async function runSseMode(url: string, auth: { user: string; password: string }): Promise<void> {
  const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const app = createMcpExpressApp();

  // SSE endpoint: GET establishes the SSE stream
  app.get("/mcp", async (req: Request, res: Response) => {
    try {
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      transportsBySessionId.set(sessionId, transport);

      const mcp = createMcpServer();
      connectedServers.add(mcp);

      transport.onclose = () => {
        connectedServers.delete(mcp);
        transportsBySessionId.delete(sessionId);
      };

      await mcp.connect(transport);
    } catch (error) {
      console.error("Error establishing SSE stream:", error);
      if (!res.headersSent) {
        res.status(500).send("Error establishing SSE stream");
      }
    }
  });

  // POST endpoint for client JSON-RPC messages
  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).send("Missing sessionId parameter");
      return;
    }
    const transport = transportsBySessionId.get(sessionId);
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error("Error handling POST:", error);
      if (!res.headersSent) {
        res.status(500).send("Error handling request");
      }
    }
  });

  app.listen(port, () => {
    console.log(`WebSocket MCP server (SSE) listening on http://127.0.0.1:${port}`);
    console.log(`  SSE endpoint: GET http://127.0.0.1:${port}/mcp`);
    console.log(`  Messages:     POST http://127.0.0.1:${port}/messages`);
  });

  startReconnectingWs(url, auth, notifyLogsUpdated);
}

async function main(): Promise<void> {
  const url = getWsUrl();
  const auth = getAuth();

  if (process.env.MCP_TRANSPORT === "stdio" || args.stdio === true) {
    await runStdioMode(url, auth);
  } else {
    await runSseMode(url, auth);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
