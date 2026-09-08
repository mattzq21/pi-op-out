# Pi define-agents extension

Defines named agents and lets you select and use them independently in Pi CLI and piop. Owns each agent's model, effort, prompts, AGENTS.md text, tools, skills, and MCP selection.

piop installs and explicitly loads its private copy from `~/.piop/pi-define-agents` locally and on SSH hosts. Existing agent configuration is copied from the former global installation, and its global entry point is removed so standalone Pi does not load it. For standalone Pi CLI use, install from this repository:

```bash
mkdir -p ~/.pi/agent/extensions/pi-define-agents
cp extensions/pi-define-agents/index.ts ~/.pi/agent/extensions/pi-define-agents/index.ts
```

Reload Pi, then select an agent with `/pi-define-agents-use reviewer`. piop discovers the extension through the `pi-define-agents` status and exposes agent selection and the Agents settings page.

The extension creates `config.json` beside itself on first load. `config.example.json` documents the format. Agent names are unique; a `default` agent is always present. Missing model or effort values inherit the session's runtime defaults. Tool declarations are strict: unavailable tools or tools denied by piop's global settings stop the run before inference. Agent skills are intersected with piop's enabled skills when running in piop. MCP tools are selected from the agent's configured servers; piop supplies the MCP bridge.

## Configuration

Agents inherit the built-in default system prompt when `systemPrompt` is omitted from `config.json`. An explicit string replaces it, including `"systemPrompt": ""` for an empty base prompt. In Settings → Agents, “Use default system prompt” omits the field when saved; turning it off allows an empty prompt. Typing in the prompt field switches to a custom prompt. Pi's append prompt, discovered project instructions, and skills remain included. Agent AGENTS.md follows, then the final line `Current working directory {project dir}` uses the session's actual directory. Customize each agent under Settings → Agents. Existing profiles with a separate instruction field are migrated into their system prompt on load, preserving the inherited default when applicable.

In piop, `web_search` is included in the default agent when globally enabled. Existing profiles receive it once on upgrade; subsequent per-agent opt-outs are preserved. New agents created in Settings inherit all globally enabled tools.

Legacy agent tool selections migrate on load: `exec_command` becomes `read`, `bash`, `grep`, `find`, and `ls`; `apply_patch` becomes `edit` and `write`. Unselected tools stay unselected.

## VM tester

`tester.example.json` contains a tester profile that accepts a production executable path and checks to perform. Merge its agent into the existing configuration's `agents` array. It inherits the session model and selects the `cua-vm` MCP server.

On Matt's local host, register this server in Piop's Settings → MCP (the agent selection uses the server **id**):

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

The broker starts or reuses an isolated VM when the tester connects. Piop supplies a stable identity for each conversation, agent name, and MCP server ID. Different conversations get separate VMs, while reconnects reuse their own VM. Selecting another agent releases the previous connection. Configure the broker on the machine where Pi runs; local paths in uploads refer to that machine.

Pass the tester the absolute path to a production binary and the requested checks. The caller builds with `./node_modules/.bin/tauri build --no-bundle -- --locked`; raw Cargo builds can leave the app pointing at the development URL. The tester uses `broker_exec` to inspect the guest launcher and `broker_upload` to transfer the build through its existing MCP lease, then tests through CUA. The guest expires after 60 seconds without MCP activity, including with its viewer open. The tester captures evidence as it works and redeploys after an expired VM is recreated. Existing tester profiles must copy the updated `systemPrompt` from the example to adopt this behavior. See [the integration contract](../../docs/cua-vm-broker.md).

`/pi-define-agents-config <base64url-json>` updates `{ "agents": [...] }` and reloads resources. piop uses this command to save definitions. Writes use temporary files and atomic publication. Older installations can import their existing agent profiles from the legacy configuration without modifying that file.
