#!/usr/bin/env bash
set -euo pipefail

driver_pid=""
mcp_pid=""

cleanup() {
  if [[ -n "$mcp_pid" ]] && kill -0 "$mcp_pid" 2>/dev/null; then
    kill "$mcp_pid" 2>/dev/null || true
    wait "$mcp_pid" 2>/dev/null || true
  fi

  if [[ -n "$driver_pid" ]] && kill -0 "$driver_pid" 2>/dev/null; then
    kill "$driver_pid" 2>/dev/null || true
    wait "$driver_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 143' INT TERM

if curl --fail --silent --max-time 1 http://127.0.0.1:4444/status >/dev/null 2>&1; then
  echo "Using the existing tauri-driver on port 4444" >&2
else
  command -v tauri-driver >/dev/null 2>&1 || {
    echo "tauri-driver is not installed or not on PATH" >&2
    exit 1
  }

  # stdout belongs exclusively to the MCP protocol; bridge logs go to stderr.
  tauri-driver --port 4444 --native-port 4445 1>&2 &
  driver_pid=$!

  for _ in {1..50}; do
    if ! kill -0 "$driver_pid" 2>/dev/null; then
      wait "$driver_pid"
      exit 1
    fi

    if curl --fail --silent --max-time 1 http://127.0.0.1:4444/status >/dev/null 2>&1; then
      break
    fi

    sleep 0.1
  done

  if ! curl --fail --silent --max-time 1 http://127.0.0.1:4444/status >/dev/null 2>&1; then
    echo "tauri-driver did not become ready on port 4444" >&2
    exit 1
  fi
fi

npx -y @wdio/mcp@latest &
mcp_pid=$!
wait "$mcp_pid"
