#!/usr/bin/env bash
set -euo pipefail

driver_pid=""

cleanup() {
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

  # Keep bridge logs away from stdout, which belongs to the MCP protocol.
  tauri-driver --port 4444 --native-port 4445 </dev/null 1>&2 &
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

# MCP must remain in the foreground so Codex's stdin/stdout stay attached.
npx -y @wdio/mcp@latest
