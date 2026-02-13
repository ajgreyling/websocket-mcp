#!/usr/bin/env node

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

function getAuth(): { user: string; password: string } {
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
    console.error("Set WS_USER and WS_PASSWORD, or WS_AUTH=username:password");
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
    perMessageDeflate: false,
  });

  ws.on("open", () => {
    appendLog(`[${new Date().toISOString()}] WebSocket connected`);
    onLogUpdate();
  });

  ws.on("message", (data: WebSocket.RawData) => {
    const text =
      typeof data === "string" ? data : (data as Buffer).toString("utf8");
    appendLog(text);
    onLogUpdate();
  });

  ws.on("close", (code, reason) => {
    appendLog(
      `[${new Date().toISOString()}] WebSocket closed (code=${code} reason=${reason.toString()})`
    );
    onLogUpdate();
  });

  ws.on("error", (err) => {
    appendLog(`[${new Date().toISOString()}] WebSocket error: ${err.message}`);
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
  const url = process.env.WS_URL;
  if (!url) {
    console.error("Set WS_URL to the WebSocket endpoint (e.g. wss://host/path?appId=...)");
    process.exit(1);
  }
  return url;
}

function createMcpServer(): McpServer {
  const mcp = new McpServer(
    {
      name: "websocket-mcp",
      version: "1.0.0",
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
        "Return recent WebSocket log entries for debugging. Optionally limit to the last N lines.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_LINES)
          .optional()
          .describe("Return only the last N lines (default: all)"),
      }),
    },
    ({ lines }) => ({
      content: [
        {
          type: "text" as const,
          text: getLogsText(lines ?? undefined),
        },
      ],
    })
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

  if (process.env.MCP_TRANSPORT === "stdio") {
    await runStdioMode(url, auth);
  } else {
    await runSseMode(url, auth);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
