# CUA VM broker integration

Piop connects to the separate `cua-vm-broker` project through standard stdio MCP. The broker owns VM provisioning, isolated writable disks, capacity, leases, and idle cleanup. Piop owns selecting an agent's servers and maintaining their MCP connections.

## Server configuration

On the machine running Pi, install/configure the broker, then add this server under Settings → MCP servers:

```json
{
  "id": "cua-vm",
  "name": "cua-vm",
  "transport": "stdio",
  "command": "/home/matt/Projects/cua-vm-broker/cua-vm-broker",
  "args": "mcp --instance-env PIOP_CUA_INSTANCE_ID",
  "startupTimeoutSec": 300,
  "enabled": true
}
```

Select `cua-vm` in the tester agent's MCP servers. A single server configuration supports multiple independent conversations. The broker must have capacity and a prepared base image; Piop does not prepare or copy VM disks. SSH-hosted Pi sessions need a broker installed on that host and paths valid there.

All MCP servers support `startupTimeoutSec` (integer 1–600, default 10). The setting covers MCP initialization; tool discovery has a 10-second request timeout and tool execution has a 120-second timeout. Piop's native command wait allows the longest enabled server startup timeout plus 30 seconds so agent changes and startup are not cut short. Settings shows `starting` while a connection is being established.

## Identity and lifetime

Piop injects `PIOP_CUA_INSTANCE_ID` into the stdio child's environment:

```text
piop- + first 32 hexadecimal characters of SHA256(
  JSON.stringify([Pi session UUID, agent name, MCP server ID])
)
```

The value survives reconnects and extension reloads. A fork/new conversation, renamed agent, or different server ID gets a different identity. Agents with the same name in different conversations remain isolated.

Only the selected agent's enabled MCP servers connect. On agent/session changes, Piop closes old connections before acquiring new ones. Shutdown and reload await MCP transport closure. The broker releases the exclusive lease on disconnect and applies its configured grace period (default 120 seconds) before stopping an idle VM, retaining its disk for reuse. A simultaneous connection using the same identity is rejected by the broker.

Servers that fail startup, are disabled, or are missing prevent the selected agent from running with a partial tool set. Another prompt retries a failed connection. Tools retained in the runtime registry from an earlier connection cannot execute through a closed or replaced connection.

## Build handoff

The broker exposes two tools on the same leased MCP connection as CUA:

- `broker_upload`: `{ "local_path": "/absolute/build", "guest_path": "/absolute/guest/executable", "executable": true }`. Paths refer to the MCP host and guest respectively. It atomically replaces the destination and returns its SHA-256 checksum, bytes, and guest path.
- `broker_exec`: `{ "argv": ["program", "argument"], "timeout_sec": 60 }`. It returns `exit_code`, `stdout`, `stderr`, `truncated`, and `timed_out`. Use at most 110 seconds from Piop, leaving room within its 120-second MCP tool timeout. Arguments are passed without implicit shell evaluation.

Both tools operate within the current connection's lease and are serialized with CUA calls. The tester reads `/home/agent/.local/bin/launch-pi`, closes the existing app, uploads the supplied production binary to the executable named there, verifies its checksum, then launches and checks the UI through CUA. No separate VM ID or SSH key is needed in the tester prompt.

## Extension coordination

`pi-define-agents` emits `piop:mcp:select` with `{ serverIds, agentName, sessionId }`. The MCP bridge synchronously assigns a `ready` promise, which resolves to the exact discovered tool names after connecting those servers. The agent awaits it before enabling tools. This uses Pi's event bus and dynamic tool registration; it does not depend on extension import order. Without defined agents, the bridge connects the globally enabled servers on session start.

## Validation on 2026-09-07

The frontend production build, Rust `cargo check --offline`, and both extensions' TypeScript checks passed. A temporary real Pi RPC session (no model requests) left an enabled but unselected MCP stopped, connected the selected broker in 43.2 seconds, discovered both broker transfer tools, released the connection on switching to default, and reconnected the same instance in 0.4 seconds. The temporary instance was deleted afterward. The broker project separately validated three concurrent guests, CUA health, exclusive leases, capacity, binary upload checksums, and reconnect persistence.
