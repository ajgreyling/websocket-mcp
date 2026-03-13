#!/bin/bash
# Start the MCP server from terminal (avoids Cursor's 401 when spawning).
# Keep this running, then use sams-logs in Cursor (url transport).
cd "$(dirname "$0")/.."
export MCP_TRANSPORT="sse"
export WS_URL="wss://helium.mezzanineware.com/api/ws2/logging?appId=03585813-94d1-404a-895a-fb62b15e4b77"
export WS_USER="${WS_USER:-27795341288}"
export WS_PASSWORD="${WS_PASSWORD:-Piering4^}"
export PORT="${PORT:-3001}"
exec node build/index.js
