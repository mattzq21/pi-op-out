#!/usr/bin/env bash
set -euo pipefail

# Attach this MCP to the embedded session printed by bun run test:e2e:manual.
# Stdout is reserved for the MCP protocol; no separate tauri-driver is needed.
exec bunx @wdio/mcp@3.12.0
