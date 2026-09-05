# Pi define-agents extension

Defines named agents and lets you select and use them independently in Pi CLI and piop. Owns each agent's model, effort, prompts, AGENTS.md text, tools, skills, and MCP selection.

Install from this repository:

```bash
mkdir -p ~/.pi/agent/extensions/pi-define-agents
cp extensions/pi-define-agents/index.ts ~/.pi/agent/extensions/pi-define-agents/index.ts
```

Reload Pi, then select an agent with `/pi-define-agents-use reviewer`. piop discovers the extension through the `pi-define-agents` status and exposes agent selection and the Agents settings page. Sequences and multi-agent modes require the separate `pi-orchestration` extension.

The extension creates `config.json` beside itself on first load. `config.example.json` documents the format. Agent names are unique; a `default` agent is always present. Missing model or effort values inherit the session's runtime defaults. Tool declarations are strict: unavailable tools or tools denied by piop's global settings stop the run before inference. Agent skills are intersected with piop's enabled skills when running in piop. MCP tools are selected from the agent's configured servers; piop supplies the MCP bridge.

## Upgrade from combined orchestration

When the sibling `pi-orchestration/config.json` still contains agents, the extension:

1. Preserves the original file as `pi-orchestration/config.json.pre-define-agents.bak` without replacing an existing backup.
2. Creates its own `config.json` from those agents, unless its configuration already exists.
3. Leaves only sequences in orchestration's configuration.

Writes use temporary files and rename. Reloading after an interrupted migration completes the split. An existing definitions file remains authoritative. Invalid JSON is reported without replacing the affected file. Once definitions exist, an invalid orchestration configuration does not prevent standalone agent use.

## Extension interface

Orchestration discovers the loaded definitions module through Pi's event bus (`pi-define-agents:request` / `pi-define-agents:ready`), independent of load order. The versioned `DefinedAgents` interface lives in `index.ts`. Agent application and child invocation settings remain owned here; orchestration owns run control and child process lifecycle. Consumers import the interface as a type only, so a missing installation can be reported without a runtime import failure.

`/pi-define-agents-config <base64url-json>` updates `{ "agents": [...] }` and reloads resources. piop uses this command to save definitions. Definitions are stored separately from sequences.
