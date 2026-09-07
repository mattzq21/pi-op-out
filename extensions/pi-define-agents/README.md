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

All agents use the shared system prompt copied from the supplied `SYSTEM.md`. An empty System prompt field inherits it; a nonempty field replaces it for that agent. This applies to new and existing profiles. Pi's append prompt, discovered project instructions, and skills remain included. Developer prompt and agent AGENTS.md follow, then the final line `Current working directory {project dir}` uses the session's actual directory. Customize each agent under Settings → Agents.

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
  "command": "/home/matt/VMs/pi-ui-xubuntu/cua-mcp.sh",
  "args": "",
  "enabled": true
}
```

This command matches the `mcp_servers.cua-vm` registration in local Codex configuration. Start the VM with `/home/matt/VMs/pi-ui-xubuntu/start-vm.sh` before opening a tester session, then select `tester`. The definition and wrapper require the local host.

Pass the tester the absolute path to a production binary and the requested checks. The caller builds with `./node_modules/.bin/tauri build --no-bundle -- --locked`; raw Cargo builds can leave the app pointing at the development URL. The tester streams the binary over the existing SSH wrapper, verifies matching checksums, and launches it through guest CUA. This follows the September 5 deployment traces; the guest launcher determines the executable name because earlier builds used both `pi-desktop` and `codop`.

`/pi-define-agents-config <base64url-json>` updates `{ "agents": [...] }` and reloads resources. piop uses this command to save definitions. Writes use temporary files and atomic publication. Older installations can import their existing agent profiles from the legacy configuration without modifying that file.
