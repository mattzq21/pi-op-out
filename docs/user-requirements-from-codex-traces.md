# Pi Desktop requirements recovered from Codex traces

This is a consolidated product record of the human-authored requests found in the Codex session traces associated with the `pi-ui` project through 2026-09-03. It records desired behavior, feature requests, UI decisions, constraints, and reported defects. It is not an implementation-status audit.

The extraction covered 50 trace files and 30 logical session IDs. Environment payloads, plugin catalogs, injected skill bodies, `AGENTS.md`, goal-state payloads, guardian/reviewer prompts, tool calls, and assistant messages were excluded. Replayed history and exact duplicate prompts were deduplicated. When the user corrected an earlier request, the latest clear correction is treated as authoritative; notable reversals are recorded at the end.

## Product and platform

- The product is **Pi Desktop**: a native UI over Pi CLI/RPC sessions, not an independent agent implementation.
- The application is Tauri-only. A standalone browser build is not a supported product surface.
- The application is Linux-first; shortcut labels should use `Ctrl`, not platform-neutral or macOS terminology.
- The product is dark-mode only. Do not expose an appearance/theme selector.
- The app should be able to sit above multiple Pi CLI instances on multiple machines. The local machine is the default host; SSH/VPS hosts are additional peers.
- Features available only in Pi's interactive terminal mode must not be advertised in the desktop UI unless they work there (the cited example was `/llama`).
- Native app branding should include a generated Tauri application icon based on the user's visual reference.

## Visual language and shell layout

- Use a genuinely dark palette: eliminate white form fields, darken the overall theme and scrollbar, and keep the session panel visually continuous with the rest of the sidebar.
- Prefer a gray message-body surface that does not stand out excessively from the shell.
- Use an orange-leaning accent rather than a red accent.
- Increase the application-wide font size. Remove DM Mono from the UI entirely.
- User messages belong on the right; assistant messages belong on the left.
- Do not show user or Pi/assistant avatars.
- Remove the app logo from the normal shell. In an empty chat, retain only the Pi character and display it at 96 px.
- Remove the system top bar without replacing its occupied space.
- Remove the chat header, including in new and split chats. Historical title requirements—centered, truncated to 50 characters, without the ready label or status dot—are superseded by this removal.
- The navigation itself should be horizontal.
- The icon rail should be narrow by default, but still wide enough for the session panel.
- The sidebar/session area should extend to the bottom of the complete chat shell, not merely to the end of the message list.
- Give `rail-bottom` 12 px of top padding and an ever-so-slightly darker background.
- The current Pi Desktop Git branch should be displayed above navigation in the icon rail, centered and prominent. It refers to the branch of the Pi Desktop repository itself, not the selected conversation project.
- Scrollbars should be thin, dark, rounded, transparent-track controls that do not grow or change color on hover or active states.

## Sidebar, projects, and session navigation

- Group sessions by project and allow every project group to be collapsed.
- Optimize the session space for finding and switching among roughly five active sessions at a time.
- Support pinned projects and pinned standalone chats. Other chats remain grouped under projects or in an all-chats area.
- Pinned-area actions apply to items within the pinned areas; all relevant item actions should remain exposed.
- `Ctrl+Tab` should focus the session space, after which arrow keys navigate it.
- A project's label should turn orange while one of its chats is open.
- Remove secondary project-label text and session metadata from session-list items.
- Session titles must stay synchronized with Pi CLI titles in both directions. If Pi's title is the first user message, Desktop should show that same title.
- Session state must be visibly distinct when completed but not yet seen; the requested color is light blue.
- Do not show the proposed yellow running-session line; that request was explicitly withdrawn.
- Remove the global hide-conversations control and the conversation-menu button.
- Remove the project switcher, native-status block, panel headings, and the leftover span in `session-copy`.
- Session actions belong in the session item's context menu or as an explicitly requested hover action.
- Show the inline archive icon at the right edge of a session item only on hover.
- The session context menu must omit compact-context and generic retry-response actions.
- The Projects button should be labeled/hinted as **New project** and open the project dialog. The system directory picker is one action inside that dialog, not the whole Projects button behavior.
- The settings button belongs immediately to the right of the New project button.

## Session lifecycle and concurrency

- Pi Desktop must be multi-session. Selecting another session in the UI must not switch or abort the currently running Pi CLI session.
- Opening a conversation should switch the shell immediately and load its history afterward.
- Large histories and streaming updates must not block the WebView. Batch deltas, keep active output separate from stable history, avoid reparsing all Markdown on every token, throttle follow-scrolling, and lazily render or paginate older content.
- New chats created with `Ctrl+N` or the new-chat button inherit the currently open project's project selection.
- If a new chat has no project, create and use `~/pi-desktop/tmp/{chatId}/`.
- A project picker should appear above the composer on the left for a new, not-yet-started chat. It opens the same dialog as New project and provides a way to open the selected project directory.
- Split-pane actions are available for every listed session except the already open session.
- A split opens vertically and contains a fully interactive second chat shell, not a read-only transcript. Split chats have no headers.
- `/btw` should open an ephemeral chat in the right split pane.
- Archiving a session must stop its owned terminals and save their state. Archived sessions should be recoverable from `~/.pi-desktop/archived/`.
- Session model and reasoning-effort selections must persist with the session.

## Conversation rendering and live work

- While an agent is working, show all live reasoning and tool activity separately and promptly.
- Once a response finishes, collapse work by default and keep the final answer visible.
- Completed tools collapse to their name plus completed state. Their output expands on demand.
- A completed tool output preview is limited to five lines and scrolls beyond that.
- Consecutive identical completed tools may be grouped, for example `bash x7 completed`, but only in the post-completion work view. Never group live calls while work is in progress.
- Reasoning belongs in the work section and should be rendered simply as plain text with a smaller, non-bold font.
- Tool-event and reasoning blocks should use a 3 px bottom margin.
- Remove bottom margin specifically from assistant messages inside `.work-group-content`.
- Replace `Work · N steps` with elapsed response time such as `Worked for 1 min 15 s`.
- Code blocks need an individual copy button with a transparent background.
- Message actions should remain below changed-file/diff information.
- Remove the mention-context treatment, the text label on the branch action, and the per-message model label.
- Clicking a tool call during streaming must not destabilize the work view.
- Streaming must accumulate Pi RPC `text_delta`, `thinking_delta`, and `toolcall_*` events instead of waiting for `message_end`; live refreshes must not overwrite newer revisions.

## Failure, abort, and retry behavior

- Distinguish ultimately failed or aborted requests from successful responses.
- Automatic retry settings must actually be honored for eligible failures.
- When the most recent response is aborted, show a dedicated retry control for that aborted turn.
- Restore the user's aborted prompt into the composer.
- Choosing retry should retry the original prompt in a clean continuation. The requested strategy is to fork to a new session and remove the abandoned old session so an abandoned turn is not duplicated.
- If the user edits/sends from the restored composer instead, treat the aborted prompt/response as abandoned and send the replacement prompt.
- Switching sessions in Desktop must never itself produce `operation aborted`.

## Composer, attachments, and commands

- The composer grows vertically when its contents no longer fit.
- Draft text is saved per session, not globally.
- Put model and effort selectors inside the composer bar and align them to its right.
- Remove the `Model` label and decorative SVGs/icons from model and effort selectors.
- The compact model control should remain within the app window and have a maximum width around 70 px.
- Remove the `gpt-` prefix from model names for display only, case-insensitively.
- Keep model menus substantially narrower than their earlier implementation.
- Agent and effort pickers should be 120 px wide with centered contents; effort option rows should be about 15 px tall while still exposing the full set of reasoning choices.
- Agent, effort, and model pickers must open consistently and stay contained inside the app window.
- The requested default is the fast variant of GPT-5.6 Sol.
- Remove the composer hint, separate attach-image button, and redundant terminal button. Keep file attachment and the explicit Open terminal action.
- Skill mentions should render as a lightly highlighted `$skillname`, not as the skill's full injected content.
- Skill commands may be inserted from anywhere in the composer. Other slash commands remain front-of-input commands.
- All command menus support highlighted first option, `Tab` acceptance, Up/Down navigation, `Escape` dismissal, and outside-click dismissal.
- Add `/compact` to Pi Desktop.
- Commands or dialogs that require a path must show the red error `Path can't be empty` instead of silently closing.

## Prompt dictionaries

- Users can define named dictionaries in Settings and in the `~/.pi-desktop/` configuration.
- Dictionaries can be enabled or disabled.
- Two enabled dictionaries may not contain the same key.
- When an enabled dictionary key occurs in the composer, highlight it yellow and reveal the replacement on hover.
- Keep the user's typed text unchanged while editing; apply replacements only after the user submits and before the prompt is sent.
- Dictionary controls must be keyboard navigable.

## Tools, skills, and permissions

- Discover skills from `~/.pi/agent/skills` and `~/.agents/skills`.
- Settings lists every discoverable skill with an enable/disable toggle, a name filter, and an enable-all/disable-all control to the right of that filter.
- Display skills in two rows with larger text and without filesystem paths.
- Put Skills above Tools in Settings.
- Remove Add skill path, per-skill remove, and global-code controls.
- Detect `user-invocable-only` metadata according to either Claude Code or Codex conventions. Such skills are forced to user-invoked-only and cannot be changed in Settings.
- Extend the MCP bridge to support HTTP transport in addition to stdio.
- Remove the filesystem MCP integration entirely.
- If an agent declares a tool that Pi does not expose or global settings deny, fail the run before inference rather than silently degrading it.
- Tool availability controls access; old conversation history may mention tools without granting current permission.

## Agents, sequences, and orchestration

- Custom agents are persistent configuration, and agents created in the UI must actually be saved.
- The default agent is visible but cannot be edited; render it as a disabled/gray option.
- A conversation may switch to another agent for a later response, with the correct tool set loaded for that selected agent.
- Provide a session broker that addresses agents by `{hostId, sessionId}`.
- Broker tools include `list_agents` and `send_message`; both are individually toggleable in Settings.
- Users can define ordered sequences of existing agents. Each agent's final answer becomes the next agent's input, and a sequence can be selected anywhere a normal agent can.
- Sequence length is the number of agents the user adds. A user-configured visible prefix runs in the foreground and displays answers; every step after that prefix runs in the background on a temporary branch-off.
- Support an orchestrator-gated mode in which the user talks only to an orchestrator. The orchestrator receives a tool containing available agent/sequence names and descriptions.
- When orchestration invokes a target, the work view shows `{agent-or-sequence name} called`.

## Remote machines and projects

- Remote hosts should behave as first-class locations for chats, projects, terminals, project opening, and project creation.
- New Project initially shows only the selected machine's home directory—not the Desktop host's home when a remote machine is selected.
- Open Project must work against the selected remote host and offer an appropriate system directory picker.
- Switching away from a VPS chat should not show redundant user-initiated session-change notices.
- A remote host selection must not leave the UI non-responsive.
- Remote and local session processing should be isolated enough that one slow Pi process or large history does not freeze other shells.

## Terminals

- Open terminals in a bottom panel owned by the current session.
- Terminals must be real PTY-backed terminals, not mock output panes.
- Allow multiple terminals per session through a plus button and tabs.
- Where the original interactive Pi terminal session exists, provide access to that actual session rather than constructing a look-alike terminal.
- Rename Clear terminal to Delete terminal; remove the code label from terminal tabs.
- For a not-yet-started chat without a CWD, show centered text: `Start the conversation to get a CWD`, using a larger and less dimmed font.
- Terminal output must not be duplicated/double-streamed.
- Cap retained terminal output/state to 32 MB per terminal to prevent runaway process memory.
- Development runs from separate worktrees must be able to obtain non-conflicting free ports rather than relying on a single fixed port.
- The user wanted visible concurrent Tauri development/test windows to occupy predictable screen quadrants when practical.

## Context, debug information, and token accounting

- A debug toggle belongs immediately left of Settings, defaults off, and has the shortcut `Ctrl+D`.
- When debug mode is on, every response shows prompt-context information outside the collapsed work section.
- The context strip includes System prompt, Tools, Skills, and Instructions (Pi project context), with visually distinct gray, blue, green, and additional instruction styling.
- Clicking a context category reveals its corresponding literal content.
- Show a circular proportional visualization of exclusive context contribution so the categories total 100%; nested skill text must not be double-counted as both System and Skills.
- Context information must persist after `message_end` and across history reloads.
- Cache-hit information in the composer and responses is also controlled by the debug toggle.
- Show per-response cache hit rate and mark it red when the cache read is below the greater of 50% of eligible tokens or 1,000 tokens.
- Show a session-wide, non-interactive cache counter next to the terminal control.
- Do not retain the later proposed previous-message cache comparison counter; it was explicitly undone.
- After compaction, the context gauge must account for compacted context rather than incorrectly displaying zero.
- Show Codex usage remaining near Settings, aligned to the right, including time until reset; display only days when more than 24 hours remain.
- Show each session's estimated equivalent API cost beside its name, but only on hover.

## Diffs and changed files

- Capture changes made by a response and place the changed-file summary inside the message body above message actions.
- List every changed file in the compact state; reveal full diffs on hover above the file list, not below it.
- Use larger text, colored additions/deletions, and a lighter filename style.
- Addition/deletion background colors should apply to the line marker/text spans rather than indiscriminately coloring nested code elements.
- Keep diff state isolated per main/split session and reset it correctly when creating, opening, or selecting sessions.

## Logs, traces, and export

- The latest session action is named **Open logs in browser**, replacing the earlier Export to HTML wording.
- Opening logs should launch them in a browser, not a text editor, and should not show a `conversation exported` notification.
- The request/log viewer should parse literal request bodies sent by Pi, show what was actually transmitted, and support filtering.
- Link back to the source session JSONL and make request sequence numbers more prominent.
- Avoid rendering every repeated request field individually where a count is clearer.
- Show available tool schemas and the skills exposed to the agent as separate inspectable categories.
- Provide a Pi tool that finds a session trace JSONL and returns a clean conversation containing only genuine user prompts and completed assistant messages—no tools, injected skills, system/developer instructions, or `AGENTS.md`.
- Pi CLI and Pi Desktop traces should be interpreted consistently using their actual instruction/system/tool/skill fields rather than assuming those items are embedded in visible user text.

## Settings organization

- Remove Steering queue and Follow-up queue settings from General.
- Move Models into General, below Automatic compaction and Automatic retry.
- Remove arrow SVGs from Settings navigation buttons.
- Add about 5% top spacing above the Settings header.
- Keep Keybindings configurable and ship sensible defaults, including Toggle terminal and Toggle debug.
- Saving settings that affect runtime capabilities must be reflected in the UI immediately and reliably.

## Testing and development workflow

- Use acceptance-oriented frontend integration tests with WebdriverIO and the embedded Tauri provider.
- Tests should exercise visible native-app behavior rather than a browser-only approximation.
- Include an acceptance flow that creates and saves a custom agent and verifies persistence.
- Manual WDIO checks should click at least three sessions and capture a screenshot for each check.
- Maintain a short, practical guide for manual testing through the WDIO MCP.
- Tauri test/dev windows should be visible during acceptance checks.
- UI mock/prototype routes should run in Tauri, keep each example conversation distinct, and support keyboard navigation; they must not overwrite the production app.
- Do not silently drop acceptance cases; if a suite count changes (the user cited 101 becoming 99), account for the omitted scenarios.
- Run `npm run tauri dev` without requiring developers to hand-manage a fixed port collision across worktrees.
- Keep documentation synchronized strictly with shipped changes.

## Reported defects and acceptance gaps

- White controls break the dark theme.
- Live text, thinking, and tool events sometimes arrive in bursts rather than incrementally.
- Clicking a tool entry during an active turn can destabilize the UI.
- Terminal output can double-stream.
- Conversation switching can be slow and can incorrectly abort active work.
- Remote host/session selection can leave the app unresponsive.
- New agents created in Settings may appear to save but are absent afterward.
- Project selection may not visibly update the UI.
- Picker popovers can escape the app window, show inconsistent contents, or fail to open.
- The agent picker can disappear or open without agents; the effort picker can omit expected options.
- `/btw` currently does nothing instead of opening the ephemeral right pane.
- Context/debug bars have appeared only on the latest response instead of every response and have disappeared at message end.
- Cache/context accounting can report zero after compaction.
- Scrollbar hover styling behaves differently in the Tauri WebView than in browser previews.
- Export/log opening can route to a text editor instead of the browser.
- Unbounded terminal retention can push the process past the system kill threshold.

## Explicit reversals and superseded requests

- `control` wording was corrected to `Ctrl`.
- A generic Retry response button was removed; a narrowly scoped retry control for the latest aborted response was later requested.
- Export to HTML was initially removed, later restored as a session action, then evolved into **Open logs in browser**. The latest name and behavior win.
- A yellow running-session line was requested and then explicitly withdrawn.
- The context strip moved from last response, to last three, to a work disclosure, and finally to every response outside work when debug mode is enabled. The last behavior wins.
- A second cache metric comparing adjacent messages was requested and then undone.
- A 25-character title limit was revised to 50, then the entire chat header was removed.
- The session panel placement was corrected repeatedly; the final shell intent is a narrow rail/sidebar reaching the full chat-shell height.
- Skill rendering was revised from hiding content, to highlighting it, to rendering `$skillname`; `$skillname` is the final form.
- Fixed development ports (`1423`, then increments) were discussed, but the later requirement is to choose an available port automatically.
