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

The identity survives reconnects and extension reloads; guest state survives only until idle cleanup. A fork/new conversation, renamed agent, or different server ID gets a different identity. Agents with the same name in different conversations remain isolated.

Selecting an agent or opening a session does not connect MCP servers. When a user submits a message, Piop connects the selected agent's enabled MCP servers and waits for tool discovery before allowing inference. On agent/session changes, Piop closes old connections and defers new connections until the next message. Shutdown and reload await MCP transport closure. The broker releases the exclusive lease on disconnect. A simultaneous connection using the same identity is rejected by the broker.

VMs are ephemeral. After 60 seconds without MCP activity, the broker closes the transport, stops the VM, and deletes its writable disk and per-VM artifacts. An open connection or viewer does not keep it alive. Startup and in-flight requests are protected from inactivity cleanup; the countdown starts when they finish. Disconnecting does not reset the countdown. Reconnecting before expiry reuses the running desktop; after cleanup, the same identity starts a fresh desktop from the base image. Save required logs and evidence outside the guest before it expires.

Piop marks a closed transport as disconnected. For defined agents, the next prompt reconnects selected servers before enabling their tools. After an idle expiry, the tester must redeploy the supplied build and recheck guest state. Piop does not send keepalive requests or replay failed tool calls.

Servers that fail startup, are disabled, or are missing prevent the selected agent from running with a partial tool set. Another prompt retries a failed connection. Tools retained in the runtime registry from an earlier connection cannot execute through a closed or replaced connection.

## Build handoff

The broker exposes two tools on the same leased MCP connection as CUA:

- `broker_upload`: `{ "local_path": "/absolute/build", "guest_path": "/absolute/guest/executable", "executable": true }`. Paths refer to the MCP host and guest respectively. It atomically replaces the destination and returns its SHA-256 checksum, bytes, and guest path.
- `broker_exec`: `{ "argv": ["program", "argument"], "timeout_sec": 60 }`. It returns `exit_code`, `stdout`, `stderr`, `truncated`, and `timed_out`. Use at most 110 seconds from Piop, leaving room within its 120-second MCP tool timeout. Arguments are passed without implicit shell evaluation.

Both tools operate within the current connection's lease and are serialized with CUA calls. The tester reads `/home/agent/.local/bin/launch-pi`, closes the existing app, uploads the supplied production binary to the executable named there, verifies its checksum, then launches and checks the UI through CUA. No separate VM ID or SSH key is needed in the tester prompt.

## Capacity and viewing

The broker defaults to five concurrent VMs (2 vCPUs and 4096 MiB each). Idle guests awaiting cleanup still occupy slots. When capacity is full, wait for cleanup and retry. The old `max_instances`, `grace_sec`, and `retention_sec` settings are ignored; inactivity is fixed at 60 seconds.

The broker opens a host viewer automatically and reuses an existing viewer on reconnect. Closing it leaves the VM and lease running until inactivity cleanup. `cua-vm-broker view --instance ID` reopens a running guest's viewer; `cua-vm-broker dashboard` shows capacity and cleanup timing. Neither viewer activity nor dashboard refreshes reset the timer. For SSH-hosted sessions, the viewer belongs to the broker host; local viewing requires an SSH tunnel.

An older running broker daemon must be restarted after its agents disconnect to load the new lifecycle (`cua-vm-broker shutdown`, then `cua-vm-broker status`). Shutdown deletes remaining unleased guests and refuses active leases.

## Extension coordination

`pi-define-agents` emits `piop:mcp:select` with `{ serverIds, agentName, sessionId }`. The MCP bridge synchronously assigns a `ready` promise, which resolves to the exact discovered tool names after connecting those servers. The agent awaits it before enabling tools. This uses Pi's event bus and dynamic tool registration; it does not depend on extension import order. Selection and session startup only apply agent configuration. The input handler emits this event and awaits readiness before allowing the message through. Without defined agents, the bridge likewise connects the globally enabled servers on input, blocking the message if connection fails.

## Contract review on 2026-09-08

Reviewed against `cua-vm-broker` revision `9976d91`, including the fixed inactivity timer and cleanup implementation. Piop already detects transport closure and reconnects defined-agent servers on the next prompt. The tester example now requires redeployment after expiry and evidence capture before cleanup. This review did not launch a VM.

## Historical validation on 2026-09-07 (before ephemeral cleanup)

The frontend production build, Rust `cargo check --offline`, and both extensions' TypeScript checks passed. A temporary real Pi RPC session (no model requests) left an enabled but unselected MCP stopped, connected the selected broker in 43.2 seconds, discovered both broker transfer tools, released the connection on switching to default, and reconnected the same instance in 0.4 seconds. The temporary instance was deleted afterward. The broker project separately validated three concurrent guests, CUA health, exclusive leases, capacity, binary upload checksums, and reconnect persistence.
