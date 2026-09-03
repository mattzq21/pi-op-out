# Pi Desktop goals

## Product experience

- Provide a native, Linux-first desktop interface over Pi CLI/RPC sessions.
- Present a cohesive, accessible dark interface with clear navigation, readable conversations, and consistent interaction patterns.
- Support local and remote Pi hosts as first-class, equivalent environments.
- Keep the application responsive while sessions stream output, load large histories, or run concurrently.

## Projects and sessions

- Make it easy to find, organize, pin, archive, restore, and switch among sessions grouped by project.
- Keep session titles synchronized between Pi Desktop and Pi CLI.
- Preserve session state, including drafts, model and reasoning selections, terminals, and unread completion status.
- Allow multiple sessions to run independently so navigating the UI never interrupts active work.
- Let users create chats within the current project and choose or create a project before starting an unscoped chat.
- Provide fully interactive split-pane conversations, including ephemeral `/btw` chats.

## Conversations and live work

- Stream assistant text, reasoning, and tool activity as it arrives.
- Separate in-progress work from the final answer, then present completed work in a compact, inspectable form.
- Render conversations, Markdown, code, tool output, changed files, and diffs.
- Keep active output responsive without repeatedly processing stable conversation history.
- Preserve correct conversation and diff state independently for every main and split session.

## Failure recovery

- Represent successful, failed, and aborted turns.
- Honor configured automatic retry behavior for eligible failures.
- Let users recover from the latest aborted turn by retrying its original prompt through a clean continuation or by editing and sending a replacement.
- Preserve the user's prompt when a turn is aborted.

## Composer and commands

- Provide a growing, keyboard-friendly composer with per-session drafts and compact model, agent, and reasoning controls.
- Support file attachments, terminal access, skill mentions, and Pi Desktop commands from the composer.
- Make command menus and selectors consistent, keyboard navigable, and contained within the application window.
- Support `/compact` as a Pi Desktop command.
- Give users clear validation feedback when required command or dialog input is missing.

## Prompt dictionaries

- Let users create, configure, enable, and disable named prompt dictionaries.
- Highlight enabled dictionary keys while preserving the text the user typed.
- Apply dictionary replacements only after submission and before sending the prompt.
- Prevent ambiguous enabled dictionaries and make dictionary management keyboard accessible.

## Skills, tools, and permissions

- Discover and manage skills from the standard Pi and shared agent skill locations.
- Let users inspect, filter, enable, and disable available skills and tools while respecting invocation metadata.
- Support MCP servers over stdio and HTTP transports.
- Enforce selected-agent and global tool permissions before inference.
- Treat current permissions, rather than historical conversation content, as the authority for tool availability.

## Agents and orchestration

- Persist user-created agent configurations and allow sessions to select an agent for each response.
- Load the correct tools and capabilities for the selected agent.
- Address agents across hosts and sessions through a session broker with configurable discovery and messaging tools.
- Let users compose ordered, reusable sequences of agents and use them anywhere a normal agent can be selected.
- Support foreground and background sequence execution while keeping visible work attributable to the invoked agent or sequence.
- Support an orchestrator-led mode that can discover and invoke configured agents and sequences.

## Remote machines and projects

- Make chats, projects, terminals, project browsing, and project creation work on local and remote hosts.
- Scope project browsing and creation to the selected machine.
- Isolate host and session processing so slow remote or local work cannot freeze unrelated conversations.

## Terminals

- Provide real PTY-backed terminals in a session-owned bottom panel.
- Support multiple tabbed terminals per session and access to an existing interactive Pi terminal when available.
- Preserve terminal state without duplicating output or allowing retained output to consume unbounded memory.

## Context, usage, and cost visibility

- Offer an optional debug view that explains the system prompt, tools, skills, project instructions, cache behavior, and token contribution for every response.
- Preserve accurate context and cache accounting across response completion, history reloads, and compaction.
- Show session-wide cache information, Codex usage remaining and reset timing, and estimated per-session API cost without obstructing normal work.

## Logs and traces

- Let users open session logs in a browser and inspect the literal requests Pi transmitted.
- Make request logs filterable and link them to their source session traces.
- Expose request sequence, tool schemas, and skills as clear inspectable information.
- Provide a Pi tool that extracts a clean conversation of genuine user prompts and completed assistant messages from a session trace.
- Interpret Pi CLI and Pi Desktop traces from their actual structured fields.

## Settings

- Organize settings around the capabilities users can understand and control, including models, retry, compaction, skills, tools, agents, dictionaries, and keybindings.
- Apply saved runtime-capability changes to the interface immediately.
- Provide configurable keybindings with practical defaults for common desktop actions.
