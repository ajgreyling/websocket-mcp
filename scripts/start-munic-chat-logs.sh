#!/bin/bash
# Start the MCP server from terminal (avoids Cursor's 401 when spawning).
# Keep this running, then use munic-chat-logs in Cursor (url transport).
cd "$(dirname "$0")/.."
export MCP_TRANSPORT="sse"
export WS_URL="wss://helium.mezzanineware.com/api/ws2/logging?appId=1d98e406-0f4c-485b-a164-18368de62fc5"
export WS_USER="${WS_USER:-27795431288}"
export WS_PASSWORD="${WS_PASSWORD:-Piering4^}"
export PORT="${PORT:-3000}"
export OUTPUT_TO_CURSOR_DEBUG_LOG="true"
export DEBUG_LOG_FILE="${DEBUG_LOG_FILE:-/tmp/munic-chat-logs-debug.log}"
exec node build/index.js
