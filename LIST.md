# Desktop multi-agent feature port

This is the complete user-facing and architectural feature set carried over from the `Desktop multi-agent` thread and its branch after the last common commit.

## Agents

- Named agent profiles with an editable name and description.
- Per-agent default model and reasoning effort.
- Per-agent system prompt, developer prompt, and `AGENTS.md` instructions.
- Per-agent allowlists for tools, skills, and MCP servers.
- A protected `default` agent that is always present.
- Agent selection in the composer, including switching an existing conversation after the current response finishes. The conversation history stays intact and later turns use the newly selected agent.
- Agent choice is persisted in the Pi session, rather than being desktop-global state.

## Sequences

- Named, described sequences made from an ordered list of agents.
- A sequence is selectable from the same composer control as an agent.
- Each agent's final answer is passed to the next agent as its input.
- Configurable visible-step count.
- Visible steps run in the foreground, appear in the conversation, and reload the next agent's model, effort, prompts, tools, skills, and MCP policy before continuing.
- Remaining steps run in the background against a temporary copy of the session branch, pass their final answers forward in order, and delete the temporary branch when finished.
- Synthetic sequence handoffs are hidden from the normal user-message display, while visible sequence steps are labeled with the sequence and agent names.

## Orchestrator

- A special `orchestrator` choice whose only active tool is `call_agent`.
- `call_agent` can invoke either a named agent or a named sequence.
- The orchestrator is told only the available agent/sequence names and descriptions and is instructed to delegate rather than do the work itself.
- Delegated calls are shown in work as `{target} called`, both while streaming and when a persisted conversation is reopened.

## Resource policy

- Tool declarations are strict: direct agents, foreground sequence steps, background sequence steps, and orchestrated child agents fail instead of silently narrowing their configured tool list when a tool is unavailable or disabled globally.
- Global desktop tool toggles remain an outer policy boundary; agents can only narrow that set.
- Agent skills are discovered per active agent and intersected with the globally enabled desktop skills.
- Agent MCP allowlists restrict which MCP servers are loaded for child runs and which MCP tools are active for foreground runs.
- Local and VPS Pi launches use `--no-skills` plus extension-owned resource discovery, preventing globally enabled skills from bypassing the active agent profile.
- Disabled desktop tools are passed as exclusions so extension-owned tools such as `call_agent` remain available when appropriate.

## Reusable Pi extension

- Orchestration is owned by the reusable `extensions/pi-orchestration` Pi CLI extension; the desktop is a capability consumer rather than the owner of orchestration state.
- The extension stores `config.json` beside itself and ships with installation documentation and an example configuration.
- Existing desktop-owned YAML profiles in `~/.pi-desktop/agents` and legacy active-agent/sequence settings are migrated without deleting the old files.
- The same agents, sequences, and orchestrator can be selected from Pi CLI with `/pi-orchestration-use`.
- Desktop configuration updates are sent through `/pi-orchestration-config`.
- The extension publishes machine-readable capability state through the `pi-desktop-orchestration` status key.
- Capability payloads use UTF-8-safe base64url JSON.
- Agent, sequence, and composer controls are hidden whenever the active Pi runtime does not publish the orchestration capability; the machine-readable `json:` status is never rendered as user-facing status text.
- The extension is staged with Pi Desktop's broker and MCP bridge on configured VPS hosts so remote Pi instances expose the same capability.

## Conversation actions

- `Export to HTML` is available in a session's right-click menu and automatically opens the exported file in the system browser. Remote exports are downloaded to a temporary local HTML file before opening.
- `Open project directory` is available in the session right-click menu for local projects.
- Archive was moved out of the context menu to a per-session archive icon on the right that appears on hover.
- Archiving stops all terminals owned by that session, marks them exited, and saves their state and output in a companion `.terminals.json` file next to the archived JSONL session in `~/.pi-desktop/archived/` (or the equivalent directory on the remote host).

## Development

- The Tauri/Vite development server uses port `1421`, avoiding the original branch's port `1420`.
