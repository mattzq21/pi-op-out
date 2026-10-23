# piop define-agents extension

Defines named agents and lets you select and use them independently in Pi CLI and piop. Owns each agent's model, effort, prompts, AGENTS.md text, tools, skills, and MCP selection.

piop installs and explicitly loads its private copy from `~/.piop/piop-define-agents` locally and on SSH hosts. Existing agent configuration is copied from the former global installation, and its global entry point is removed so standalone Pi does not load it. For standalone Pi CLI use, install from this repository:

```bash
mkdir -p ~/.pi/agent/extensions/piop-define-agents
cp extensions/piop-define-agents/{index.ts,extension-loader.ts} ~/.pi/agent/extensions/piop-define-agents/
```

Each session uses one agent. Choose the agent before sending the first message; after that, selection is locked, including after reopening the session. Model and effort can still be changed. Start a new session to use a different agent.

Reload Pi, then select an agent with `/pi-define-agents-use reviewer`. piop discovers the extension through the `pi-define-agents` status and exposes agent selection and the Agents settings page.

The extension creates `config.json` beside itself on first load. `config.example.json` documents the format. Agent names are unique; a `default` agent is always present. Missing model or effort values inherit the session's runtime defaults. Tool declarations are strict: unavailable tools or tools denied by piop's global settings stop the run before inference. Agent skills are intersected with piop's enabled skills when running in piop. MCP tools are selected from the agent's configured servers; piop supplies the MCP bridge.

## Configuration

Agents inherit the built-in default system prompt when both `systemPrompt` and `path_systemprompt` are omitted from `config.json`. An explicit string replaces it, including `"systemPrompt": ""` for an empty base prompt. In Settings → Agents, “Use default system prompt” omits the field when saved; turning it off allows an empty prompt. Typing in the prompt field switches to a custom prompt. Pi's append prompt, discovered project instructions, and skills remain included. Agent AGENTS.md follows, then the final line `Current working directory {project dir}` uses the session's actual directory. Customize each agent under Settings → Agents. Existing profiles with a separate instruction field are migrated into their system prompt on load, preserving the inherited default when applicable.

Use `path_systemprompt` instead of `systemPrompt` to load the base prompt from a UTF-8 file. The two fields are mutually exclusive. Relative paths resolve beside `config.json`; absolute paths and `~/` are also supported. Files are read on the host running Pi, including for SSH sessions. The file is reread when the agent activates and before each input; an unreadable file blocks the run. Settings → Agents supports “Use system prompt file”. Empty files provide an empty base prompt.

In piop, `web_search` is included in the default agent when globally enabled. Existing profiles receive it once on upgrade; subsequent per-agent opt-outs are preserved. New agents created in Settings inherit all globally enabled tools.

Legacy agent tool selections migrate on load: `exec_command` becomes `read`, `bash`, `grep`, `find`, and `ls`; `apply_patch` becomes `edit` and `write`. Unselected tools stay unselected.

## VM tester

`tester.example.json` contains a tester profile that accepts a production executable path and checks to perform. Merge its agent into the existing configuration's `agents` array and copy `sysprompt/tester.example.md` into a `sysprompt` directory beside that configuration (on each host running the tester). It inherits the session model and selects the `cua-vm` MCP server.

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

Selecting the tester does not start MCP or a VM. When a user submits a message, Piop connects the tester's MCP servers and waits for their tools to load before sending the message to the model. The broker starts or reuses an isolated VM during that connection. Piop supplies a stable identity for each conversation, agent name, and MCP server ID. Different conversations get separate VMs, while reconnects reuse their own VM. Selecting another agent releases the previous connection. Configure the broker on the machine where Pi runs; local paths in uploads refer to that machine.

Pass the tester the absolute path to a production binary and the requested checks. The caller builds with `./node_modules/.bin/tauri build --no-bundle -- --locked`; raw Cargo builds can leave the app pointing at the development URL. The tester uses `broker_exec` to inspect the guest launcher and `broker_upload` to transfer the build through its existing MCP lease, then tests through CUA. The guest expires after 60 seconds without MCP activity, including with its viewer open. The tester captures evidence as it works and redeploys after an expired VM is recreated. Existing tester profiles can replace `systemPrompt` with `"path_systemprompt": "sysprompt/tester.example.md"` after copying the prompt file.

`/pi-define-agents-config <base64url-json>` updates `{ "agents": [...] }` and reloads resources. piop uses this command to save definitions. Writes use temporary files and atomic publication. Older installations can import their existing agent profiles from the legacy configuration without modifying that file.

## Agent piop extensions

Add `"extensions": ["/path/to/extension.ts", "./extensions/reviewer"]` to an agent, or enter one path per line in Settings → Agents → piop extensions. Paths resolve on the host running the agent. Relative agent paths resolve beside `config.json`; `~/` and absolute paths work too. Directories need `index.ts`, `index.js`, `index.mjs`, or `index.cjs`.

A piop extension can declare dependencies with a named `extensions` export. These paths resolve relative to the declaring module:

```ts
export const extensions = ["./shared.ts"];

export default function reviewer(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`Reviewer loaded in ${ctx.cwd}`, "info");
  });
}
```

Dependencies initialize before their parent, once per activation group, including when shared by several parents. Missing files, invalid exports, cycles, duplicate registrations, and thrown initialization errors reject the entire group. No staged handlers, commands, tools, or event-bus subscriptions become active on a factory failure. If startup fails, the group is deactivated and the previous agent remains selected. RPC selection reports the error; an invalid restored agent blocks input before inference.

Factories register tools, commands, shortcuts, flags, renderers, and handlers through the supplied API. Keep initialization free of external side effects; use `session_start` for runtime API calls and `session_shutdown` for cleanup. Resource registrations must happen in the factory. The loader stages API registrations, but cannot undo arbitrary filesystem writes or other side effects made directly by extension code. Extensions share the same session context and conversation history. Their registered tools are enabled with the agent; changing the selection before the first message deactivates the previous agent’s handlers, commands, and tools. Global piop extensions remain active.

The dependency export is interpreted by piop's agent loader, not by Pi's ordinary extension loader. Existing `pi-define-agents` command/status identifiers remain compatible; repository and installed extension paths use `piop-`. Existing private agent and fast-mode directories migrate on local and SSH hosts.
