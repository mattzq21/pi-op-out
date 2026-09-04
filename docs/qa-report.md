# Manual WDIO MCP QA report — 2026-09-04

## Findings

### WDIO-001 — Long custom-group names overflow the entire session scroller

**Severity:** Medium

**Reproduction**

1. Click **New session group**.
2. Enter a long unbroken name (the check used 309 characters).
3. Blur the input to save the group.

**Observed**

The group label is not constrained, wrapped, or ellipsized. It expands far beyond the 260px sidebar and creates a horizontal scrollbar. The measured `.session-scroll` dimensions changed from `clientWidth: 251px` to `scrollWidth: 2537px`; the label itself measured `2517px` wide.

**Expected**

The group label should remain within the sidebar, using truncation or safe wrapping without horizontal overflow.

**Relevant code**

- `src/styles.css`: `.project-label` / `.project-label span`

### WDIO-002 — The first click on a session after a cross-group drag is swallowed

**Severity:** High

**Reproduction**

1. Drag a session from one project/group into another group.
2. Click the moved session once.
3. Click it a second time.

**Observed**

The first click does not select the session and produces no session-switch backend calls. The second click selects it normally. In the controlled scenario, the first click left no active session and only periodic `list_sessions` calls were recorded; the second click activated the item and issued `load_git_diffs`, `git_branch`, `stop_pi`, and `start_pi` calls.

The drag completion assigns `suppressClickRef.current` unconditionally. A cross-element drag does not naturally dispatch a click on the source button, so the suppression remains stale until the user's next intentional click.

**Expected**

The first intentional click after completing a drag should select the moved session. Click suppression should expire at the end of the drag gesture or only consume the synthetic click associated with that gesture.

**Relevant code**

- `src/components/SessionPanel.tsx`: `startMouseDrag`, `finish`, and `renderSession` click handler

### WDIO-003 — Empty custom-group headers remain visible for a zero-result search

**Severity:** Low

**Reproduction**

1. Have one or more empty custom groups.
2. Search for a string that matches no conversations, such as `__qa_no_match__`.

**Observed**

The sidebar displays the unrelated custom-group headers above `No conversations match “__qa_no_match__”.` In the observed state, both `Important Work` and `Second Group` remained visible despite zero matching conversations.

**Expected**

A conversation search with no matches should show only the empty-result state, or custom groups should be shown only when they contain matching sessions.

**Relevant code**

- `src/components/SessionPanel.tsx`: `customVisualGroups` is built from every custom group without filtering empty groups while `query` is active

### WDIO-004 — New-group draft reappears after every sidebar remount

**Severity:** High

**Reproduction**

1. Click **New session group** once.
2. Enter a name, then press `Ctrl+B` to collapse the conversation panel.
3. Press `Ctrl+B` again to reopen it.
4. Press Escape to cancel the blank draft.
5. Collapse and reopen the panel again.

**Observed**

The typed name is lost when the panel closes. Reopening the panel automatically displays a blank **Group name** input. Even after cancelling it with Escape, the blank draft returns after the next panel remount.

`createGroupRequest` remains nonzero in `App`, while `SessionPanel` treats any nonzero value as a fresh request in an effect that also runs on mount. Every later remount therefore recreates the draft.

**Expected**

One click of **New session group** should create one draft request. Closing/cancelling it should consume that request, and later sidebar remounts should not recreate it.

**Relevant code**

- `src/App.tsx`: `createGroupRequest`
- `src/components/SessionPanel.tsx`: effect keyed by `createGroupRequest`

### WDIO-005 — Moving a session under another physical project creates contradictory project behavior

**Severity:** High

**Reproduction**

1. Have a session whose actual `cwd` is in project Alpha.
2. Drag it onto the physical Beta project header.
3. Open the moved session's context menu and choose **Open project directory**.

**Observed**

The session is rendered under Beta and its persisted visual location is Beta, but its runtime data remains Alpha. In the controlled check, `QA Alpha Three` was rendered with `data-project-key="local:/tmp/qa-beta"` and stored at `local:/tmp/qa-beta`, while **Open project directory** invoked:

```json
{
  "cwd": "/tmp/qa-alpha",
  "hostId": "local"
}
```

Selecting the session likewise starts Pi with the session's original Alpha working directory. The physical project heading therefore communicates a project move that has not actually occurred.

**Expected**

Physical project sections should reflect the session's real project/cwd. Cross-project drops should either perform a real supported relocation, be rejected, or be represented as a neutral/custom grouping that does not imply the working directory changed.

**Relevant code**

- `src/components/SessionPanel.tsx`: `moveSession` persists a visual `sessionLocations` override for physical project keys
- `src/App.tsx`: session actions continue to use the original `SessionSummary.cwd`

### WDIO-006 — The advertised `Ctrl K` conversation-search shortcut does nothing

**Severity:** Medium

**Reproduction**

1. Focus the message composer.
2. Press `Ctrl+K` while the conversation sidebar is expanded.
3. Collapse the sidebar with `Ctrl+B`, then press `Ctrl+K` again.

**Observed**

The message composer keeps focus and the search field is not focused. When the sidebar is collapsed, it also remains collapsed. The check dispatched the same kind of window keyboard event used to verify the working `Ctrl+B` shortcut, ruling out a WebDriver key-delivery limitation.

The search field visibly shows a `Ctrl K` key hint, but there is no corresponding key handler or keybinding definition.

**Expected**

`Ctrl+K` should focus conversation search. When the sidebar is collapsed, it should first open it and then focus search, or the UI should not advertise the shortcut.

**Relevant code**

- `src/components/SessionPanel.tsx`: the search label renders `<kbd>Ctrl K</kbd>` without shortcut behavior
- `src/App.tsx` and `src/lib/keybindings.ts`: no conversation-search action is registered

### WDIO-007 — Conflicting global shortcuts can be saved without warning

**Severity:** Medium

**Reproduction**

1. Open **Settings → Keybinds**.
2. Assign `Ctrl+B` to **New conversation**, which is already assigned to **Toggle conversations**.

**Observed**

Both fields display `Ctrl+B`, no validation message appears, and **Save changes** is enabled. Runtime shortcut dispatch uses the first matching definition, so a saved collision silently makes the later action unreachable; in this example `Ctrl+B` starts a new conversation instead of toggling the sidebar.

**Expected**

Settings should reject duplicate non-empty shortcuts, clearly identify the conflict, or explicitly resolve it before saving.

**Relevant code**

- `src/components/SettingsView.tsx`: keybinding validity does not check for duplicate shortcuts
- `src/App.tsx`: `keybindDefinitions.find(...)` executes only the first matching action

### WDIO-008 — Invalid context-window caps do not block saving

**Severity:** Medium

**Reproduction**

1. Open **Settings → General**.
2. Set **Context window cap** to `500`, below the input's declared minimum of `1000` (the same occurs with zero).

**Observed**

The native input reports `checkValidity() === false`, but no validation message is rendered and **Save changes** remains enabled. The invalid numeric value is already copied into the React settings draft.

**Expected**

The save action should remain disabled and explain the minimum, or the input should clamp/reject values below 1000.

**Relevant code**

- `src/components/SettingsView.tsx`: `Context window cap` has `min={1000}`, but `formValid` and `validationError` do not validate `draft.contextWindowCap`

### WDIO-009 — Enabled MCP servers accept unusable connection fields

**Severity:** Medium

**Reproduction**

1. Open **Settings → MCP servers** and add a server.
2. Change its transport to **HTTP**.
3. Leave URL empty and enter `not json` for **Headers (JSON)**.

The stdio variant is also reproducible by clearing the **Command** field of a new enabled stdio server.

**Observed**

No validation is shown and **Save changes** remains enabled. The URL field is `type="url"` but is not required, the header text is not parsed until the MCP bridge is configured, and an empty stdio command is accepted. Basic configuration errors are therefore deferred to a reconnect/runtime failure.

**Expected**

An enabled HTTP server should require a valid HTTP(S) URL, non-empty headers should be validated as a string-valued JSON object, and an enabled stdio server should require a command before Save is enabled.

**Relevant code**

- `src/components/SettingsView.tsx`: MCP fields are excluded from `formValid` / `validationError`
- `src-tauri/resources/mcp-bridge.ts`: headers and URLs are interpreted only when the runtime bridge configures the server

### WDIO-010 — Custom session groups cannot be renamed or deleted

**Severity:** Medium

**Reproduction**

1. Create a custom session group, including an empty group or one with a typo.
2. Inspect its header with mouse, keyboard, and context-menu interactions.

**Observed**

The group header exposes only its collapse/expand button. There is no rename, delete, or group context-menu action. The group remains in `pi-desktop-session-groups` indefinitely, even when it contains no sessions; removing it requires manually editing application localStorage.

**Expected**

Custom groups should have discoverable rename and delete actions. Deleting a non-empty group should preserve its sessions by moving them to a defined fallback location.

**Relevant code**

- `src/components/SessionPanel.tsx`: custom and physical groups share the same collapse-only `project-label` rendering; mutation exists only for group creation

### WDIO-011 — Same-name conversations in one project can be indistinguishable

**Severity:** Low

**Reproduction**

1. Have multiple conversations with the same generated or assigned name under one project.
2. Give two of them the same rounded API cost.

**Observed**

Rows render only the conversation name and rounded cost. In the observed real session list, one project contained four conversations named `hi`; two exposed the identical accessible name `hi, $0.02` and two exposed `hi, $0.03`. Neither the visual label nor accessible name supplies a date, preview, message count, or other discriminator.

**Expected**

Rows with colliding names should include a concise discriminator such as preview text or relative modification time, including in their accessible names.

**Relevant code**

- `src/components/SessionPanel.tsx`: `renderSession` uses only `session.name` and `formatApiCost(session.apiCost)`, despite `SessionSummary` also containing preview/message metadata

### WDIO-012 — The branch badge reports Pi Desktop's build checkout, not the active project

**Severity:** High

**Reproduction**

1. Open a conversation whose working directory is a Git repository on a known branch.
2. Compare the branch badge at the top of the rail with that repository.

**Observed**

The active conversation was rooted at `/home/matt/Agents/yoo`, where `git branch --show-current` reports `main`, but the application rail displayed `HEAD`. `HEAD` is the state returned from Pi Desktop's detached build worktree. The branch command does not accept the active cwd or host, so switching conversations cannot correct it.

**Expected**

The badge should show the branch of the active conversation's project and update when the active project changes. It should be absent for non-Git projects and support or explicitly omit remote projects.

**Relevant code**

- `src-tauri/src/lib.rs`: `git_branch` runs `git -C env!("CARGO_MANIFEST_DIR") ...`
- `src/lib/nativeTransport.ts`: `gitBranch()` passes no cwd or host
- `src/App.tsx`: the branch refresh is keyed to transport, but the backend ignores that transport's project

### WDIO-013 — Starting another new conversation silently strands an unsent draft

**Severity:** Medium

**Reproduction**

1. Click **New conversation** from an existing project.
2. Type an unsent draft, but do not submit it.
3. Click **New conversation** again.

**Observed**

The second blank conversation replaces the first and shows an empty composer. The first blank conversation never appears in the sidebar, so its draft cannot be reopened. In the measured run, the sidebar stayed at 11 rows with no active row both before and after replacement, and no row contained the unique draft text. The abandoned draft also remains in `composerDrafts` after its transport is released because only uploads and the transport map entry are cleaned.

**Expected**

The app should confirm before replacing a non-empty draft, make draft conversations navigable, or explicitly carry the draft into the replacement. Released draft keys should not remain in memory.

**Relevant code**

- `src/App.tsx`: `newSession` does not check the active composer draft
- `src/App.tsx`: `activateTransport` releases an unused previous transport but does not remove its `composerDrafts` entry

### WDIO-014 — Replacing an unused conversation leaks its terminal process

**Severity:** High

**Reproduction**

1. Start a new conversation but do not send a message.
2. Open its terminal panel, which starts a shell process.
3. Click **New conversation** again.

**Observed**

The old conversation and terminal panel disappear. The recorded backend calls included `start_terminal` followed by `stop_pi`, but no `close_terminal`. A direct `resize_terminal` call using the orphaned terminal ID still succeeded afterward, proving the terminal process remained registered and alive despite having no navigable UI. The QA process was explicitly closed after verification.

Repeated use can accumulate inaccessible shell processes and their retained React terminal state.

**Expected**

Releasing an unused conversation should close every terminal associated with its conversation key and remove that key from `terminalsBySession`.

**Relevant code**

- `src/App.tsx`: `activateTransport` calls `runtimePool.release(previousTransport)` without closing IDs in the previous `SessionTerminals`
- `src/lib/nativeTransport.ts`: `dispose()` stops Pi but has no ownership or cleanup of Tauri terminal processes
- `src-tauri/src/lib.rs`: terminal processes remain in the global `TerminalRuntime` until `close_terminal` or archive cleanup is called

### WDIO-015 — Terminal shortcut ignores the active split pane

**Severity:** Medium

**Reproduction**

1. Keep a main conversation rooted at project A.
2. Open a split conversation rooted at project B.
3. Focus the split-pane composer and press `Ctrl+J`.

**Observed**

The terminal opened for the main conversation, not the focused split conversation. In the live check, the right pane was `/home/matt/Agents`, the main pane was `/home/matt/Agents/yoo`, and the terminal prompt was `~/Agents/yoo`. Focus left the right composer as the terminal opened.

**Expected**

The terminal shortcut should target the active pane, matching the app's existing `activePane` focus model, or the UI should make clear that the terminal is permanently scoped to the main pane.

**Relevant code**

- `src/App.tsx`: `focusComposer` branches on `activePane`, but `toggleTerminal` does not
- `src/App.tsx`: the only `TerminalView` is bound to main-pane `activeCwd`, `terminalSessionId`, and `transport`

### WDIO-016 — Removing one agent silently deletes every sequence that uses it

**Severity:** Medium

**Reproduction**

1. Configure agents `qa-a` and `qa-b` and a sequence `qa-flow` containing both.
2. In **Settings → Agents**, remove `qa-a`.
3. Open **Sequences**.

**Observed**

`qa-flow` disappears entirely, the Sequences page says **Add a sequence to get started**, and **Save changes** is enabled. There is no confirmation or indication that removing one agent also staged deletion of a separate configuration object.

**Expected**

The UI should warn that dependent sequences will be deleted, block removal until dependencies are resolved, or remove only that step when a valid sequence remains.

**Relevant code**

- `src/components/SettingsView.tsx`: `removeAgent` filters out every sequence whose `agents` array includes the removed name

### WDIO-017 — Session context menus detach from their row while the sidebar scrolls

**Severity:** Low

**Reproduction**

1. Open a conversation's context menu in a scrollable sidebar.
2. Scroll the conversation list without clicking elsewhere.

**Observed**

The menu remains at its original viewport coordinates while its source row moves underneath it. In the measured check, the source row moved from `319px` to `150px` from the viewport top, while the menu stayed at `327px`. It consequently appeared attached to unrelated rows.

**Expected**

The menu should dismiss on sidebar scroll or update its position to remain anchored to the source row.

**Relevant code**

- `src/components/SessionPanel.tsx`: menu dismissal listens for window click, keydown, and blur, but not `.session-scroll` scroll

### WDIO-018 — Every inline archive button has the same accessible name

**Severity:** Low

**Reproduction**

1. Navigate through the conversation sidebar with accessibility tooling or the keyboard.
2. Inspect the inline archive buttons for multiple rows.

**Observed**

All 11 rendered archive buttons exposed the name **Archive conversation**. Their `title` attributes included each session name, but the explicit identical `aria-label` overrides that text for assistive technology. A user navigating controls cannot tell which conversation a focused archive action targets.

**Expected**

Each accessible name should include the target, for example **Archive git, innit mate?**.

**Relevant code**

- `src/components/SessionPanel.tsx`: every `session-archive` uses `aria-label="Archive conversation"` while only `title` is session-specific

### WDIO-019 — The active conversation is indicated only by color

**Severity:** Low

**Reproduction**

1. Select a conversation.
2. Inspect its session button through the accessibility tree.

**Observed**

The wrapper gains the visual class `active`, but the button has no `aria-current`, `aria-selected`, or pressed state. For the active `git, innit mate?` row, all three attributes were absent. Assistive technology receives the same role/state as inactive conversation buttons.

**Expected**

The selected conversation should expose a programmatic current/selected state in addition to its color treatment.

**Relevant code**

- `src/components/SessionPanel.tsx`: active state is applied only as a wrapper CSS class

### WDIO-020 — Changing a selected project starts the browser at home instead of that project

**Severity:** Medium

**Reproduction**

1. Start a blank conversation with a selected project.
2. Click the selected-project button above the composer.

**Observed**

The button's title identified the current project as `/home/matt/Agents/yoo`, but the **Open project** dialog populated **Project directory** with `/home/matt`. Opening the in-app directory browser likewise began at the home directory, forcing the user to navigate back down from home rather than starting at the project being changed.

`ProjectDialog` accepts `initialPath`, but its host-loading effect overwrites it with the host home directory. `App` currently passes an empty initial path in any case.

**Expected**

When changing an already selected local project, the dialog should start at that project. A host change can reset to the newly selected host's home directory.

**Relevant code**

- `src/App.tsx`: renders `ProjectDialog initialPath=""`
- `src/components/ProjectDialog.tsx`: the mount/host effect unconditionally calls `setPath(home)`

### WDIO-021 — Terminal tabs expose no active-tab semantics

**Severity:** Low

**Reproduction**

1. Open the terminal panel and add a second terminal.
2. Inspect the two terminal controls through the accessibility tree.

**Observed**

Both controls are ordinary buttons. The active `Terminal 2` differs only through the CSS class `active`; it has no tab role, `aria-selected`, `aria-current`, or pressed state. Both buttons also remain in the normal tab order rather than using tablist keyboard semantics.

**Expected**

The terminal switcher should use a `tablist`/`tab` pattern with the active tab exposed through `aria-selected`, or otherwise provide an equivalent programmatic selected state.

**Relevant code**

- `src/components/TerminalView.tsx`: terminal tabs are plain buttons whose active state is class-only

### WDIO-022 — Inline message actions are indistinguishable in the accessibility tree

**Severity:** Low

**Reproduction**

1. Open a conversation containing multiple completed assistant responses.
2. Navigate its controls with accessibility tooling or the keyboard.

**Observed**

Every response exposes controls named only **Copy response** and **Branch from here**. In the live conversation, the accessibility tree contained 12 instances of each name. The surrounding `article` elements have no accessible label or description that identifies which response a focused action belongs to, so a controls list cannot distinguish the targets.

**Expected**

Message actions should provide target context programmatically, for example by labeling the response article and associating its controls with that label, while keeping the visible compact icon treatment.

**Relevant code**

- `src/components/Message.tsx`: every completed assistant message renders the same two action labels inside an unlabeled `article`

### WDIO-023 — Attachment-limit errors remain after all attachments are removed

**Severity:** Low

**Reproduction**

1. Attach 13 small text files in the composer.
2. Observe that 12 are accepted and **Only 12 attachments are allowed** appears.
3. Remove all 12 accepted attachments.

**Observed**

The composer contains no attachments and Send is disabled, but the attachment-limit alert remains visible and exposed in the accessibility tree. It clears only when another file-selection attempt starts or a prompt is submitted.

**Expected**

Removing files should clear a limit error once the composer is back within the relevant limit, or the alert should offer an explicit dismiss action.

**Relevant code**

- `src/components/Composer.tsx`: attachment removal updates `uploads` but does not update `uploadError`

### WDIO-024 — A terminal start failure leaves the tab permanently marked as started

**Severity:** Medium

**Reproduction**

1. Open the terminal panel and add a new terminal tab.
2. Make `start_terminal` fail (the check injected `QA terminal start failure`).
3. Close and reopen the terminal panel.

**Observed**

The tab initially displays **Could not start terminal: Error: QA terminal start failure**. Reopening it does not retry `start_terminal`; the recorded calls contained only `resize_terminal` attempts for the terminal ID that never started, and those errors are suppressed. The stale failure output remains. The only UI recovery is to delete the tab and create another one.

The tab is marked `started: true` before the backend call. The catch path appends an error but never resets that flag, so later mounts take the already-started branch.

**Expected**

A failed start should return the tab to a retryable state, either retrying when reopened or exposing an explicit retry action. Resize should not be attempted until start has succeeded.

**Relevant code**

- `src/App.tsx`: `startTerminal` sets `started: true` before awaiting `transport.startTerminal` and does not revert it on failure
- `src/components/TerminalView.tsx`: a mounted tab with `started` set calls `onResize` instead of `onStart`

### WDIO-025 — Arbitrary binary files are silently inserted into prompts as text

**Severity:** Medium

**Reproduction**

1. Attach a small non-image binary file, such as an `application/octet-stream` `.bin` file.
2. Add prompt text and submit.

**Observed**

The file is accepted as a normal text attachment. With the provider call intercepted, a five-byte payload containing `00 ff 01 02 41` produced this prompt content:

```text
<file name="payload.bin">
\0�\x01\x02A
</file>
```

The binary data was decoded with `FileReader.readAsText`, introducing NUL/control bytes and a Unicode replacement character into the model prompt. There is no file-type warning or indication that decoding was lossy.

**Expected**

The composer should reject unsupported binary types, detect invalid text decoding, or use a supported binary/document attachment representation instead of silently treating every non-image file as text.

**Relevant code**

- `src/components/Composer.tsx`: `addFiles` sends every MIME type that does not start with `image/` through `readFile(file, "text")`
- `src/components/Composer.tsx`: the file input has no `accept` restriction

### WDIO-026 — Settings navigation does not expose the active section

**Severity:** Low

**Reproduction**

1. Open Settings.
2. Inspect the section-navigation controls through the accessibility tree.
3. Switch between sections.

**Observed**

The selected section receives only the CSS class `active`. For the visually active **General** button, `aria-current`, `aria-pressed`, and `aria-selected` were all absent. The same was true of every inactive section, so assistive technology cannot determine which settings page is displayed.

**Expected**

The active section should expose a programmatic current state, such as `aria-current="page"`, in addition to its visual treatment.

**Relevant code**

- `src/components/SettingsView.tsx`: section buttons apply only `className={section === item.id ? "active" : ""}`

### WDIO-027 — Renaming a custom agent to `default` makes it impossible to edit or remove

**Severity:** High

**Reproduction**

1. Open **Settings → Agents**.
2. Add an agent.
3. Change its name to `default`.

**Observed**

The custom agent immediately acquires all built-in-agent restrictions because those restrictions are keyed only by its name. Its name input becomes disabled, its Remove button becomes disabled, and its list entry becomes disabled and displays **Built in**. The original built-in agent remains beside it with the same name and state.

Save is disabled because agent names are now duplicated, but no validation error is shown. The custom agent cannot be renamed or removed, so the only recovery is to leave Settings and discard every staged change.

**Expected**

The reserved name `default` should be rejected before it is applied, or built-in identity/editability should be represented independently from the mutable agent name. Invalid drafts must remain editable and removable.

**Relevant code**

- `src/components/SettingsView.tsx`: agent list, name input, and Remove button all infer built-in identity with `agent.name === "default"`
- `src/components/SettingsView.tsx`: duplicate names make `agentsValid` false, but `validationError` does not explain invalid agent names

### WDIO-028 — Agent and sequence validation can disable Save without explaining why

**Severity:** Medium

**Reproduction**

1. Open **Settings → Agents**, add an agent, and clear its name.
2. Observe the Settings header.
3. Give the agent a valid name, add a sequence, and rename the sequence to `default`, colliding with the built-in agent.

**Observed**

Both states disable **Save changes**, but no alert or field-level validation message appears. The same silent gate applies to duplicate agent names, duplicate sequence names, and other conditions represented only in `agentsValid` or `sequencesValid`. The user must infer which field is invalid by trial and error.

**Expected**

Every condition that disables Save should produce a specific, discoverable validation message and identify the affected field or item.

**Relevant code**

- `src/components/SettingsView.tsx`: `formValid` includes `agentsValid` and `sequencesValid`, while `validationError` covers neither set of naming/structure failures

### WDIO-029 — Forked, retried, and cloned sessions lose their project-files baseline

**Severity:** High

**Reproduction**

1. Complete an assistant turn in a Git-backed conversation so `pi-project-files-watch` records a snapshot.
2. Change a file during the next turn, then abort that assistant response.
3. Retry the restored prompt from the desktop UI.

**Observed**

The desktop replaces the aborted tail by forking the session to a new ID and deleting the old session file. The copied JSONL contains the old `pi-project-files-watch-snapshot` custom entry, but the extension does not read that entry: it looks up refs only under the current session ID.

In the controlled check, the fork changed session ID from `00000000-0000-4000-8000-000000000029` to `01a06bf7-4981-743a-ad1b-1f06327765ff`. Git still contained only the old-ID ref. Running the extension's input lifecycle with the new ID injected nothing; running the same lifecycle with the old ID correctly reported `changed-after-abort.txt`.

The old session file was deleted, but its hidden Git ref remained. The retry therefore both loses the previous baseline—so changes made before the abort are omitted—and leaves an unreachable per-session snapshot ref behind indefinitely.

The standard clone workflow has the same association failure even when no aborted turn is involved. A live source conversation with a single snapshot ref cloned successfully from session `01a06915-1a94-7404-a36b-96c2ede4c07e` to `01a06c28-9ef2-7203-a34f-ab51107c73de`, but the clone had no ref under its new session ID. Because `currentSnapshot` resolves only the current ID, its first user message cannot report changes relative to the shared conversation's last completed assistant turn.

**Expected**

Whenever Pi creates a new session identity from existing history, the snapshot association should be transferred or copied to the new ID. For aborted-turn replacement, the old ref should also be removed when the old session is deleted. Changes made since the shared last assistant turn should remain visible to the first user message in a retry, branch, or clone.

**Relevant code**

- `src/App.tsx`: the aborted-turn send path forks to a new session and then deletes the old session file
- `src/App.tsx`: branch and clone actions accept Pi's new session identity without transferring project-file snapshot refs
- `extensions/pi-project-files-watch/index.ts`: `currentSnapshot` resolves only refs derived from `ctx.sessionManager.getSessionId()` and does not recover the copied snapshot entry
- `src-tauri/src/lib.rs`: `delete_session` removes session artifacts without removing that chat's Git snapshot ref

### WDIO-030 — Archiving a conversation leaves its split-pane runtime open and usable

**Severity:** Medium

**Reproduction**

1. Open a non-active conversation in the split pane.
2. Archive that same conversation from its sidebar archive control.
3. Inspect the secondary pane after the archive succeeds.

**Observed**

The archived conversation remains mounted in the split pane. Its message composer is still enabled and the secondary `NativeTransport` remains connected. In the controlled check, `archive_session` succeeded for the split conversation while `.chat-panes.split`, the split close control, and the enabled split composer all remained present.

The archive backend moves the session JSONL and stops only explicitly supplied terminal IDs; it does not stop the Pi runtime that has the session open. The main archive path does not recognize that the target is `splitPane.session`, close the pane, or release its pooled runtime.

**Expected**

Successfully archiving a conversation should close any split pane displaying it and release that conversation's runtime before or as part of moving its session artifacts. The user should not be able to continue sending commands to a session that the sidebar considers archived.

**Relevant code**

- `src/App.tsx`: the archive action handles the active main session specially but never checks or closes `splitPane`
- `src-tauri/src/lib.rs`: `archive_session` moves the session files and stops supplied terminals, but does not stop a Pi runtime
- `src/lib/nativeTransport.ts`: `archiveSession` invokes the archive command without disconnecting the transport

### WDIO-031 — Editing the project path leaves directory results from the old path actionable

**Severity:** Low

**Reproduction**

1. Open the project dialog and choose **Choose directory…** to load the home-directory listing.
2. Manually change the project path from `/home/matt` to `/tmp`.
3. Click one of the still-visible entries from the old listing, such as `.agents`.

**Observed**

Changing the input updates only the path string. All 58 directory controls loaded for `/home/matt` remained visible while the field displayed `/tmp`. Clicking the stale `.agents` result then navigated to `/home/matt/.agents`, not anywhere below the path currently shown in the input.

**Expected**

Manually editing the path should clear the previous listing, or refresh it for the new path before its entries remain actionable. The displayed path and the directory controls should always describe the same location.

**Relevant code**

- `src/components/ProjectDialog.tsx`: the project-path input clears `error` but does not clear or refresh `listing`
- `src/components/ProjectDialog.tsx`: directory buttons retain and submit their absolute paths from the previous `DirectoryListing`

### WDIO-032 — Retry in a split pane appends after the aborted turn instead of replacing it

**Severity:** High

**Reproduction**

1. Open a conversation whose latest assistant response was aborted in the split pane.
2. Observe that the prompt is restored in the split composer and the failed response offers **Retry**.
3. Click **Retry** and inspect the Pi command lifecycle.

**Observed**

The split pane sent the restored text directly as another `prompt`. In the controlled fixture, Retry issued `prompt("QA split aborted turn")` and cleared the composer, with no `fork` command and no deletion of the old session.

The main composer handles this state differently: it locates the abandoned user entry, forks from that point, deletes the old session, refreshes, and only then submits the retry. The split pane bypasses all of that replacement logic, leaving the original user message and aborted assistant entry in history before appending the duplicate prompt.

**Expected**

Retry should have the same abandoned-turn replacement semantics in both panes. The split pane should fork from the original user entry and continue from a clean history, or the UI should not describe a direct append as a retry.

**Relevant code**

- `src/App.tsx`: main-pane `send` contains the `findReplaceableAbortedTurn` fork/delete workflow
- `src/components/SplitChatPane.tsx`: split-pane `send` always maps a normal send directly to `transport.command({ type: "prompt" })`
- `src/components/ChatView.tsx`: both panes restore the aborted prompt and wire **Retry** through their respective `onSend` callback

### WDIO-033 — A live orchestration status update silently discards unsaved agent and sequence edits

**Severity:** High

**Reproduction**

1. Open **Settings → Agents** and change an agent field without saving.
2. While Settings remains open, deliver a new valid `pi-desktop-orchestration` status from the active extension runtime.

**Observed**

The incoming status immediately replaces all `agentDrafts` and `sequenceDrafts` and resets the Settings baseline. In the controlled check, the unsaved `agent-1` description changed from `QA UNSAVED DESCRIPTION` back to an empty string as soon as the status arrived. **Save changes** became disabled and no warning or discard confirmation appeared.

A malformed/cleared status is more disruptive: an unsaved `QA LOST ON CLEAR` edit caused the **Agents** and **Sequences** navigation items to disappear, switched the page to **General**, and disabled Save. Restoring a valid status brought the sections back without restoring the draft.

Any unsaved agent and sequence work can therefore disappear or become inaccessible because of an asynchronous extension update that the user did not initiate from the form.

**Expected**

Live orchestration state should not overwrite dirty form drafts. The UI should defer the update, merge only non-edited runtime metadata, or ask before replacing unsaved changes.

**Relevant code**

- `src/App.tsx`: orchestration `setStatus` requests replace the top-level `orchestration` state immediately
- `src/components/SettingsView.tsx`: the `incomingOrchestrationRef` effect unconditionally replaces both draft arrays and rewrites `baselineRef.current`, without checking `dirty`

### WDIO-034 — A save error remains after the form is reverted to a clean state

**Severity:** Low

**Reproduction**

1. Change a Settings field.
2. Make `save_app_settings` fail.
3. Revert the edited field exactly to its saved value.

**Observed**

The failed save correctly preserves the draft and initially leaves Save enabled. After reverting the context cap from the test value `201000` to its saved value `200000`, the form became clean and **Save changes** became disabled, but the `QA save failure` alert remained visible.

Because the clean form cannot be saved, there is no in-place action that clears or supersedes the stale failure. It remains until Settings is closed.

**Expected**

A save error should clear when the user edits or reverts the form, or it should provide a dismiss action. A clean form should not continue to report a failure for a value it is no longer trying to save.

**Relevant code**

- `src/components/SettingsView.tsx`: `saveError` is cleared only at the beginning of another `save` call
- `src/components/SettingsView.tsx`: draft changes and transitions back to `dirty === false` do not clear `saveError`

### WDIO-035 — Branching keeps the fork's unsent draft under the original conversation ID

**Severity:** Medium

**Reproduction**

1. Enter an unsent composer draft in a saved conversation.
2. Use **Branch from here** on one of its assistant responses.
3. Materialize the new fork, switch back to the original conversation, then return to the fork.

**Observed**

The fork initially kept displaying `QA DRAFT BEFORE BRANCH`, but its Pi session ID had changed. Switching to the original source conversation showed that same draft there. Switching back to the materialized fork showed an empty composer.

The fork updates Pi's session state and `SessionRuntimePool` binding, but the app's `transportConversationKeys` entry remains keyed by the original session ID. Draft updates after the fork therefore continue writing to the source conversation's key until the fork is selected from the sidebar and the mapping is replaced.

**Expected**

When a branch changes the active session ID, per-conversation UI state should be rekeyed to the new fork. The draft that remains visible after branching should remain with the fork and should not appear in the original conversation.

**Relevant code**

- `src/App.tsx`: `branch` forks and refreshes but does not update the transport's conversation key
- `src/App.tsx`: `setComposerDraft` stores values under `activeConversationKeyRef.current`
- `src/App.tsx`: `refresh` rebinds the runtime pool to the new session ID without rekeying `transportConversationKeys` or associated UI state

### WDIO-036 — Split-pane work has no running or new-activity state in the sidebar

**Severity:** Medium

**Reproduction**

1. Open a non-active conversation in the split pane.
2. Start an agent turn in that split conversation.
3. Compare the split pane's working state with its sidebar row.

**Observed**

The split pane displayed **Pi is working**, but its `hword` sidebar row did not receive the `running` class and its accessible label remained `hword, $0.04` without **Running**. In the same controlled lifecycle event, the active main session did receive the running class and `Running` label.

Completing the split turn also produced neither the `unseen` class nor **New activity** in the accessible label. A user looking only at the sidebar therefore gets no indication while split work runs or when it finishes.

`SessionRuntimePool` knows that the split transport is running, but derives sidebar session keys only from transports registered in its `sessions` map. Split panes create an unbound transport, so that running transport has no session key to publish.

**Expected**

A conversation running in either pane should use the same sidebar color and accessible running state. Split transports should be associated with their session identity while mounted.

**Relevant code**

- `src/components/SplitChatPane.tsx`: split panes call `runtimePool.create(...)` rather than binding the transport to the session
- `src/lib/sessionRuntimePool.ts`: `publishSessionStates` emits keys only by filtering entries in `this.sessions`

### WDIO-037 — An active streaming conversation can be archived without stopping its Pi runtime

**Severity:** High

**Reproduction**

1. Start an agent turn in the active conversation.
2. While **Pi is working** is visible, use that conversation's inline archive control and confirm.
3. Inspect the command sequence.

**Observed**

The archive control remains enabled during streaming. In the controlled check it dispatched `archive_session` and then `pi_command:new_session` while the turn was active, with no `abort`, `stop_pi`, or settle step between them.

The backend archive command moves the live session JSONL and stops only the supplied terminal IDs. It does not stop the Pi runtime that is still producing the response. The frontend then asks that same transport to start a new session, creating a race between the in-flight turn, the moved session file, and the new-session command.

**Expected**

Archiving the active conversation should be disabled until the turn settles, or it should explicitly abort and stop/release the runtime before moving session artifacts and starting another conversation.

**Relevant code**

- `src/components/SessionPanel.tsx`: inline archive controls are not disabled for running sessions
- `src/App.tsx`: active archive calls `archiveSession` and then `new_session` without aborting or disconnecting the transport
- `src-tauri/src/lib.rs`: `archive_session` moves files and stops terminals but does not stop a Pi runtime

### WDIO-038 — A double archive activation starts two destructive workflows for the same conversation

**Severity:** Medium

**Reproduction**

1. Confirm archive prompts automatically or accept them quickly.
2. Activate the active conversation's archive button twice before the first archive finishes.

**Observed**

Both activations proceed independently. The controlled check recorded two `archive_session` calls for the same path followed by two `pi_command:new_session` calls. The archive control is not disabled and there is no per-session pending guard.

Against the real backend, the calls race to move the same file: one can succeed while the other reports a misleading failure, and both active-session continuations can attempt to reset the transport and UI.

**Expected**

Only one archive workflow should be allowed per conversation at a time. The archive control should become disabled immediately after confirmation and subsequent activations should be ignored until the operation settles.

**Relevant code**

- `src/App.tsx`: `sessionAction` has pending guards for new-session, abort, and branch workflows but none for archive
- `src/components/SessionPanel.tsx`: the archive button receives no pending or disabled state

### WDIO-039 — Branch from here drops the selected response and its user prompt

**Severity:** High

**Reproduction**

1. Open a saved conversation containing one completed user/assistant turn.
2. Click **Branch from here** on the assistant response.
3. Inspect the new fork, then send a message to materialize it and revisit both conversations.

**Observed**

The new fork initially had no messages. After sending a minimal prompt, its persisted history contained only that new prompt and answer; the original user prompt and the assistant response whose branch button was clicked were absent.

The button is rendered on an assistant response, but the branch handler searches backward for the preceding user message and sends that user's entry ID to Pi's `fork` RPC. Pi's default fork position is `before`: for a user entry it selects the user's parent as the new leaf. In a one-turn conversation that parent is the root, so the fork is empty by design at the RPC layer even though the Desktop action is labelled as branching from the assistant response.

**Expected**

Branching from an assistant response should preserve the conversation through that selected response. Desktop should fork at the assistant entry (using Pi's supported `position: "at"` semantics where appropriate), rather than forking before its preceding user prompt.

**Relevant code**

- `src/components/Message.tsx`: **Branch from here** is attached to each assistant response
- `src/App.tsx` and `src/components/SplitChatPane.tsx`: both branch handlers pass the preceding user entry ID
- Pi `agent-session-runtime`: `fork(entryId)` defaults to `position: "before"` and branches from the selected user's parent

### WDIO-040 — Extension input requests from background conversations are dropped without a response

**Severity:** High

**Reproduction**

1. Open conversation A, then switch to conversation B so A's runtime remains pooled in the background.
2. Have an extension in A emit an `extension_ui_request` that requires a response, such as `confirm` or `input`.
3. Inspect the UI and transport calls, then select A again.

**Observed**

A targeted `confirm` request from the background `hword` transport produced no dialog, notice, or `extension_ui_response` call. Selecting `hword` afterward still showed no request. The extension-side promise is therefore left waiting indefinitely unless some unrelated timeout or cancellation ends it.

`App` subscribes its full event handler only to the currently selected transport. `SessionRuntimePool` keeps a lightweight lifecycle subscription on background transports, but it does not handle extension requests. Although the full handler contains logic intended to cancel input requests from a non-active transport, that handler is unsubscribed as soon as another transport becomes active, so the cancellation branch is unreachable for requests that actually arrive in the background.

**Expected**

Background extension requests should be retained and surfaced when the conversation is selected, or immediately receive an explicit cancellation and produce a visible indication that the background task needs attention. No request that requires a response should disappear without either outcome.

**Relevant code**

- `src/App.tsx`: the event-listener effect subscribes only to the current `transport` and cleans up on transport change
- `src/App.tsx`: the `transport !== activeTransportRef.current` cancellation branch lives inside that active-only subscription
- `src/lib/sessionRuntimePool.ts`: pooled background subscriptions process lifecycle and diff events, but not `extension_ui_request`

### WDIO-041 — Reopening a saved conversation overwrites its model with the global default

**Severity:** High

**Reproduction**

1. Set the global default model to Sol with medium thinking.
2. Save a conversation whose current model is Luna and whose thinking level is high.
3. Switch to another conversation, then reopen the saved conversation.
4. Inspect both the composer selectors and the saved JSONL.

**Observed**

The reopened conversation displayed Sol and medium instead of its saved Luna/high state. Its JSONL was also mutated immediately on open: a new `model_change` entry selecting `openai-codex/gpt-5.6-sol` was appended after the prior Luna assistant response, without sending a message or changing the selector manually.

The connection path calls `configureRuntime` for every selected transport. That routine unconditionally sends the global `defaultModel` and `defaultThinkingLevel`, so opening an existing conversation treats defaults as overrides rather than initialization values. Existing real session files also contain repeated identical model-change entries consistent with this happening on routine reopen.

**Expected**

An existing conversation should resume with its persisted model and thinking level. Global defaults should initialize new conversations only, and merely opening a saved conversation should not append configuration changes to its history.

**Relevant code**

- `src/App.tsx`: `configureRuntime` unconditionally calls `set_model` and `set_thinking_level` with global defaults
- `src/App.tsx`: the transport connection chain invokes `configureRuntime` before refreshing every selected session

### WDIO-042 — Unsupported image formats are accepted and forwarded unchanged

**Severity:** Medium

**Reproduction**

1. Attach a small SVG file whose browser MIME type is `image/svg+xml`.
2. Send the attachment.
3. Inspect the prompt sent to Pi.

**Observed**

Desktop accepted `vector.svg` as an image without warning and sent it as a raw image block with `mimeType: "image/svg+xml"` and the original SVG bytes. The same path accepts every MIME value beginning with `image/`.

Pi's normal file processor recognizes or normalizes images before prompting, and its directly supported image set is PNG, JPEG, GIF, and WebP. The RPC prompt path does not process incoming image blocks: it passes Desktop's MIME type and bytes through to the provider adapter. For OpenAI-compatible providers that becomes an unchanged `data:image/svg+xml;base64,...` image URL, leaving an otherwise valid composer submission to fail at provider preflight or generation time.

**Expected**

Desktop should restrict attachments to Pi's supported image formats or normalize convertible formats before enabling send. Unsupported `image/*` files should produce a local, actionable validation error rather than being forwarded unchanged.

**Relevant code**

- `src/components/Composer.tsx`: `addFiles` treats every `file.type.startsWith("image/")` value as a valid image
- Pi RPC/session prompt path: incoming image blocks are appended without image processing
- Pi image utilities: the directly supported MIME set is PNG, JPEG, GIF, and WebP

### WDIO-043 — A failed turn-diff save is shown as successful until reload

**Severity:** Medium

**Reproduction**

1. Complete a turn that produces a project diff.
2. Make `save_git_diffs` fail while capture, history lookup, and diff generation succeed.
3. Inspect the completed assistant response, then reload the application.

**Observed**

The synthetic `qa-unsaved.txt` change appeared immediately under the response even though `save_git_diffs` returned an error. No alert, status, or retry control indicated that persistence had failed. After a full reload, the change disappeared because it had existed only in the runtime pool's in-memory `snapshots` object.

The pool publishes the optimistic snapshot before awaiting persistence. Its queue-level catch suppresses the save error and only discards the temporary Git baseline, leaving the optimistic UI state in place for the rest of the process lifetime.

**Expected**

A failed diff save should be surfaced and retried, or the optimistic snapshot should be rolled back with a visible warning. The UI should not present volatile state exactly like successfully persisted conversation history.

**Relevant code**

- `src/lib/sessionRuntimePool.ts`: `captureTurnEnd` updates and notifies `diffState.snapshots` before awaiting `saveGitDiffs`
- `src/lib/sessionRuntimePool.ts`: the capture queue catch suppresses all persistence errors and does not restore the prior snapshot map

### WDIO-044 — Extension notifications from a split-pane conversation disappear

**Severity:** Medium

**Reproduction**

1. Open a saved conversation in the split pane.
2. Have an extension in that split runtime emit an `extension_ui_request` with method `notify`.
3. Inspect both panes and the outgoing RPC calls.

**Observed**

A targeted warning notification containing `QA split notification` produced no notice, dialog, status, or other visible text in either pane. Desktop also sent no response or diagnostic call. The same notification method is surfaced by the main-pane handler, but the split handler falls through after handling only prompt context, orchestration state, editor text, and response-requiring dialogs.

Generic extension statuses, widgets, MCP statuses, and title updates are omitted by the same split-only event dispatch path, so extensions can behave observably differently solely because their conversation is opened beside another one.

**Expected**

Split conversations should expose supported extension UI events consistently with the main conversation, with ownership scoped to the pane where necessary. At minimum, user-facing notifications must not be silently discarded.

**Relevant code**

- `src/components/SplitChatPane.tsx`: the `extension_ui_request` handler has no branches for `notify`, generic `setStatus`, `setWidget`, MCP status, or `setTitle`
- `src/App.tsx`: the corresponding main-pane handler surfaces these event methods

### WDIO-045 — A transient split-pane action failure permanently replaces the chat

**Severity:** Medium

**Reproduction**

1. Open a saved conversation in the split pane.
2. Make a model-change RPC fail once.
3. Select the model in the split pane, then allow subsequent RPCs to succeed.

**Observed**

After the forced `set_model` failure, the entire split conversation—including its history, composer, and controls—was replaced by the bare text `QA transient model failure`. Clearing the failure did not restore any controls or provide a retry action; the only remaining control was **Close split pane**, so recovery required closing and reopening the conversation.

The same top-level error state is used for transient branch, abort, agent, model, and thinking-level failures. Once any of those setters records an error, successful runtime events cannot clear it because the `ChatView` subtree is no longer rendered and no action remains available inside the pane.

**Expected**

Action failures should appear as dismissible notices or inline errors while leaving the conversation usable. A healthy connected runtime should not be hidden permanently because one command failed.

**Relevant code**

- `src/components/SplitChatPane.tsx`: `{error ? ... : <ChatView ...>}` makes every error fatal to the pane UI
- `src/components/SplitChatPane.tsx`: model, thinking, agent, branch, and abort handlers all write transient failures into that same persistent `error` state

### WDIO-046 — A transient saved-diff load failure is cached as an empty history

**Severity:** Medium

**Reproduction**

1. Open a conversation with saved per-turn diffs in the split pane.
2. Make its initial `load_git_diffs` call fail once.
3. Allow later calls to succeed and trigger a normal session refresh.
4. Close and reopen the split pane.

**Observed**

The conversation rendered all 28 messages but none of its six saved diff panels, with no error or loading indication. A later `message_end` refresh did not issue another `load_git_diffs` call and the panels remained absent. Closing and reopening the pane created a new transport, retried the load, and immediately restored all six panels.

`loadSavedDiffs` converts any load error into `EMPTY_DIFFS` and leaves that resolved promise cached under the session key. Subsequent requests for the same key return the failed empty result, so the current runtime has no recovery path even after the backend is healthy.

**Expected**

Transient load failures should be visible and retryable. A failed empty result must not be memoized as authoritative saved history for the lifetime of the transport.

**Relevant code**

- `src/lib/sessionRuntimePool.ts`: `loadSavedDiffs` catches failures as `EMPTY_DIFFS` but retains `state.load`
- `src/lib/sessionRuntimePool.ts`: matching session keys return the cached promise without retrying

### WDIO-047 — Cloning or branching a conversation loses its saved response diffs

**Severity:** Medium

**Reproduction**

1. Open a conversation whose history contains six saved **Project changes** panels.
2. Choose **Clone conversation**, then inspect the active clone immediately, its files on disk, and the same clone after a full reload.
3. Separately, branch from the final assistant response and compare the retained message IDs with the source sidecar.

**Observed**

The new clone initially displayed all six source diff panels even though its new JSONL had no matching `.diffs.json` sidecar. The clone and source had distinct session IDs, and only the source sidecar existed on disk. After reloading and reopening the clone, all six panels disappeared.

The branch retained 26 messages and every assistant entry ID referenced by the source's six saved diffs, but it displayed zero diff panels immediately and likewise created no sidecar. This is metadata loss rather than a consequence of the already documented dropped branch prompt: all six diff-bearing responses were present in the forked JSONL.

Desktop keeps diff state on the reused `NativeTransport`, so clone can temporarily inherit the source session's in-memory snapshot map. Pi's clone and fork RPCs create a new JSONL, but Desktop does not copy or filter the per-response diff sidecar to the new session path. Clone's stale in-memory display therefore looks successful until a clean load exposes the loss, while branch loaded the missing sidecar immediately and exposed the empty history at once.

**Expected**

Cloning should copy the source's saved per-response diff history under the new session path. Branching should copy the subset whose message IDs exist in the new branch. Until persistence succeeds, neither workflow should display inherited volatile diff state as though it belongs to the new session.

**Relevant code**

- `src/App.tsx`: clone and branch delegate their session switch to Pi without copying Desktop's diff sidecar
- `src/lib/sessionRuntimePool.ts`: diff snapshots are keyed by transport, which can make clone temporarily retain source state across the session switch
- `src-tauri/src/lib.rs`: saved diffs are stored beside the source JSONL as a path-derived `.diffs.json` file

### WDIO-048 — An initial connection failure cannot be retried from the active conversation

**Severity:** Medium

**Reproduction**

1. Select a saved conversation and make its first `start_pi` call fail once.
2. Allow later starts to succeed.
3. Click the same active conversation in the sidebar again.
4. Switch to another conversation and then back.

**Observed**

The failed conversation remained selected with its composer disabled and a `Pi could not connect` alert. After the failure was cleared, clicking that same sidebar item issued no second `start_pi` call and left the conversation unusable. Switching away and back did issue a new start, cleared the alert, and restored the composer.

`selectSession` returns early whenever the requested ID and host already match state, without checking whether that transport is connected. An initial start failure does not emit the later `disconnected` event that drives automatic reconnect, and the error toast offers only dismissal rather than retry.

**Expected**

Clicking the active failed conversation should retry its transport, or the connection error should expose a dedicated retry action. Recovery should not require knowing to open an unrelated conversation first.

**Relevant code**

- `src/App.tsx`: `selectSession` returns the current transport solely on matching session ID and host
- `src/App.tsx`: reconnect scheduling runs only in the `disconnected` event branch, not after initial `connect()` rejection
- `src/App.tsx`: the connection error toast has a dismiss action but no retry action

### WDIO-049 — Concurrent main and split extension dialogs overlap and share the wrong accessible title

**Severity:** Medium

**Reproduction**

1. Open one saved conversation in the main pane and another in the split pane.
2. Have both runtimes issue a `confirm` extension UI request before either request is answered.
3. Inspect the two open dialogs visually and through their `aria-labelledby` references.
4. Cancel the top request and inspect the request underneath it.

**Observed**

Both native modal dialogs opened at exactly the same coordinates and dimensions. The main conversation's request sat on top of the split conversation's request, with no conversation identity in either dialog. Both dialogs used `aria-labelledby="extension-dialog-title"`; resolving that ID from either dialog returned the split request's title. The visible **Main conversation request** was therefore exposed to assistive technology as **Split conversation request**.

Canceling the top dialog correctly sent `extension_ui_response` to the main runtime and revealed the preserved split request underneath, so the requests are not lost. The collision nevertheless makes ownership ambiguous and gives the top dialog an objectively incorrect accessible name.

**Expected**

Only one application-level extension dialog should be presented at a time, with clear conversation ownership, or concurrent pane dialogs should be spatially and semantically distinct. Every dialog title ID must be unique and resolve within its own dialog.

**Relevant code**

- `src/App.tsx`: the main pane renders its own `ExtensionDialog` independently of the split pane
- `src/components/SplitChatPane.tsx`: the split pane renders a second `ExtensionDialog` without coordinating with the application-level queue
- `src/components/ExtensionDialog.tsx`: every instance hard-codes `aria-labelledby="extension-dialog-title"` and `id="extension-dialog-title"`

### WDIO-050 — A send that completes after switching conversations clears the wrong draft

**Severity:** High

**Reproduction**

1. Put an unsent draft in conversation B.
2. Switch to conversation A and enter a different message.
3. Send A's message and switch to B before the prompt command promise settles.
4. After the send succeeds, inspect both composers.

For a deterministic check, I mocked only A's `prompt` response and clicked **Send message** and conversation B synchronously in the same renderer task. No provider request or real message was created.

**Observed**

A's prompt command was accepted by A's runtime, but the success callback cleared B's unrelated unsent draft. Returning to A showed its already-sent text still in the composer. This combines user-authored draft loss with a realistic risk of accidentally submitting A's message twice.

The composer awaits `onSend` and only then calls its captured `onDraftChange`. App's `setComposerDraft` does not capture the conversation that initiated the send; it reads `activeConversationKeyRef.current` when the promise settles, which by then points at B.

**Expected**

Send completion must clear the draft belonging to the transport/conversation that initiated that send, regardless of subsequent navigation. It must never mutate the newly active conversation's draft.

**Relevant code**

- `src/components/Composer.tsx`: `submit` calls `setValue("")` only after the asynchronous `onSend` settles
- `src/App.tsx`: `setComposerDraft` chooses its storage key from mutable `activeConversationKeyRef.current` at callback time

### WDIO-051 — Active-session archive completion can replace a conversation selected during the archive

**Severity:** High

**Reproduction**

1. Start archiving the active conversation A.
2. Before `archive_session` settles, select a cold conversation B.
3. Let A's archive succeed while B's initial `start_pi` fails.
4. Inspect the selected sidebar item, chat contents, connection alert, and composer state.

I made the race deterministic by mocking only `archive_session` as successful and B's `start_pi` as failed, then clicking A's archive action and B synchronously. A's subsequent `new_session` was the real Pi RPC, so its post-archive state transition was not simulated and no session file was moved.

**Observed**

B initially became the selected target and its start failed with `QA cold destination failed`. When A's archive continuation ran, no sidebar session remained active, B's history was replaced by a blank chat in A's **Agents** project, and the blank composer was enabled even though the visible connection alert still reported B's failure.

The archive handler captures `isActiveSession` before awaiting the backend, then unconditionally mutates application-global conversation, connection, project, and transport state after success. It never verifies that A is still active. Its `new_session` and refresh therefore race B's selection and connection lifecycle.

**Expected**

Archiving A may remove A from the index, but completion must not replace or mark connected a different conversation selected while the archive was pending. Post-archive blank-session setup should occur only if A is still the active transport; otherwise A should be cleaned up in the background.

**Relevant code**

- `src/App.tsx`: `sessionAction` computes `isActiveSession` before `await transport.archiveSession(...)`
- `src/App.tsx`: the active branch later clears global messages/state, calls `new_session` on the captured transport, refreshes global session state, and calls `updateConnected(true)` without rechecking ownership

### WDIO-052 — A notification burst pushes older alerts permanently outside the viewport

**Severity:** Medium

**Reproduction**

1. Have an extension issue 24 `notify` UI requests without dismissing earlier notices.
2. Inspect the fixed toast stack in a 900×640 application window.
3. Try to reach the oldest notices with the pointer or by scrolling the stack.

**Observed**

All 24 notices were retained and rendered. Their fixed stack grew to 1,432px tall with its top at −808px. The first notice occupied y=−808…−756 and the first 14 notices were entirely above the application viewport. The stack reported `overflow: visible`; it had no height cap, scrollbar, grouping, expiry, or bulk-dismiss action. Only the most recent notices remained pointer-accessible.

Because dismissing a visible notice only removes that individual item, users must work backward through the remaining visible notices before older errors move on-screen. A noisy or failing extension can therefore hide the earliest and often most causally useful errors while covering a large part of the chat indefinitely.

**Expected**

The notice area should remain bounded and reachable under bursts—for example by capping retained notices, coalescing repeats, expiring informational notices, or using a scrollable region with a clear-all action.

**Relevant code**

- `src/App.tsx`: `addNotice` appends every item to an unbounded array and notices are removed only one at a time
- `src/styles.css`: `.toast-stack` is fixed to the bottom but has no `max-height` or overflow behavior

### WDIO-053 — Bare Escape keybindings collide with built-in dismissal behavior

**Severity:** Medium

**Reproduction**

1. In **Settings → Keybinds**, focus **New conversation shortcut** and press Escape.
2. Save the resulting bare `Escape` binding and return to chat.
3. Open a composer picker or command palette and press Escape to dismiss it.

The save was exercised with `save_app_settings` and subsequent settings loads mocked to the edited object, so the active UI used the new binding while the real settings file retained `Ctrl+N`. A reload restored the real keymap.

**Observed**

The keybinding editor accepted `Escape` with no warning. Dispatching Escape with that keymap immediately started a fresh conversation and removed the active sidebar selection. Composer picker and command-palette Escape handlers call `preventDefault()` but do not stop propagation, so their built-in dismissal keystroke also reaches the window-level shortcut handler and invokes the assigned global action.

Dialogs avoid this only because the global handler checks for an open `<dialog>`; popovers and the inline command palette receive no equivalent protection. The same collision can be assigned to other global actions, including toggling panels or debug mode.

**Expected**

Reserved navigation/dismissal keys should either be rejected as bare global shortcuts or child controls that consume them should stop propagation before the global shortcut resolver runs.

**Relevant code**

- `src/lib/keybindings.ts`: `shortcutFromEvent` accepts any multi-character key name, including unmodified `Escape`
- `src/components/Composer.tsx`: both the command palette and `ComposerPicker` handle Escape without `stopPropagation()`
- `src/App.tsx`: the window keydown listener runs global actions whenever no native dialog is open

### WDIO-054 — Saving an unrelated setting resends the entire orchestration configuration

**Severity:** Medium

**Reproduction**

1. Open Settings while the orchestration extension is active.
2. Change only **New conversation shortcut** under **Keybinds**.
3. Save and inspect the RPC calls made after `save_app_settings` and the runtime reconnect.

**Observed**

The keybinding-only save sent a large `prompt` command beginning `/pi-orchestration-config ` to the active runtime. Its encoded payload contained every agent, prompt, tool, skill, MCP allowlist, and sequence, despite none of those fields being edited.

`SettingsView` always passes a reconstructed orchestration object to `onSave` whenever orchestration is available. App interprets any supplied object as an orchestration edit and submits the full configuration after reconnect. This adds unnecessary extension traffic and can overwrite a newer configuration established outside this stale Settings draft; failures also make an unrelated keybinding save appear to fail and trigger rollback.

**Expected**

The orchestration configuration command should be sent only when agent or sequence data differs from its baseline. Saves confined to general settings, keybindings, dictionaries, machines, tools, skills, or MCP connection data should not rewrite orchestration state.

**Relevant code**

- `src/components/SettingsView.tsx`: `save` always calls `onSave(draft, currentOrchestration)` rather than passing orchestration only when that portion is dirty
- `src/App.tsx`: `saveSettings` treats every truthy `nextConfig` as an orchestration change and sends `/pi-orchestration-config ...`

### WDIO-055 — Saving settings silently terminates an active response and strands its turn state

**Severity:** High

**Reproduction**

1. Start an assistant response and wait for its `agent_start` event.
2. While the response is active, open **Settings** and change an unrelated value such as **Context window cap**.
3. Click **Save changes**, return to chat, and inspect the runtime calls and session state.

I injected only the lifecycle `agent_start` event to make the active-response state deterministic, then allowed the Git baseline capture and runtime process commands to execute normally. Settings persistence and the orchestration prompt were mocked so the user's real configuration and conversation were not changed.

**Observed**

Saving issued a real `stop_pi` followed by `start_pi` for the active runtime. The in-flight response disappeared without an abort confirmation, interruption message, error, or notice. After returning to chat, the sidebar still announced the conversation as **Running**, even though the replacement process had loaded an idle saved state and there was no active response in the transcript.

The turn's Git baseline was also left alive across the restart: `capture_git_tree` had created `pi-desktop-diff-4bc9571c-f8db-48cf-85fc-e2d549d5a74a`, but the settings save emitted no `discard_git_tree`. A subsequent synthetic `agent_end` on the replacement process consumed that stale baseline through `load_git_diff`, proving that the pre-restart turn state remained queued and could be paired with an unrelated later completion. The baseline directory was removed by that cleanup step.

`NativeTransport.saveSettings` reconnects for every save. Its direct `disconnect()` clears listeners and stops Pi without emitting the `disconnected` event on which `SessionRuntimePool` relies to clear running state and discard pending baselines.

**Expected**

Settings must not silently restart a runtime with an active turn. The app should either prevent/confirm the save until the turn settles or explicitly abort the turn, reconcile its UI state, and discard its Git baseline before reconnecting. A baseline captured before restart must never be applied to a later turn.

**Relevant code**

- `src/App.tsx`: Settings remains accessible while `state.isStreaming`, and `saveSettings` delegates every settings save to the active transport
- `src/lib/nativeTransport.ts`: `saveSettings` calls `disconnect()` and `connect()`; `disconnect()` stops Pi but does not emit a `disconnected` event
- `src/lib/sessionRuntimePool.ts`: running state and queued baselines are cleared on an observed `disconnected` event, while later `agent_end` events consume the oldest queued baseline

### WDIO-056 — Opening Settings silently aborts an active split-pane response

**Severity:** High

**Reproduction**

1. Open a saved conversation in the split pane.
2. Start a response in that pane and wait until it shows **Pi is working** and **Stop**.
3. Click the global **Settings** button without saving anything.
4. Return to chat and inspect the split conversation and process calls.

I made the response state deterministic by injecting `agent_start` into the split runtime `e7d83ce2-6b5f-4b99-b4a5-74e1328b5e58`. The split pane exposed an enabled **Stop Pi** control before Settings was opened.

**Observed**

Opening Settings immediately issued `stop_pi` for the split runtime because the entire chat workspace was unmounted. There was no confirmation, explicit `abort` command, interruption entry, error, or notice. Returning to chat silently created a replacement split runtime showing the saved conversation in an idle state with a normal **Send message** control; the interrupted response had simply vanished.

This differs from the main-pane settings-save failure: the user does not need to edit or save a setting. Navigation alone destroys the live split transport, while the main transport remains mounted outside `SettingsView`.

**Expected**

Opening Settings should preserve an active split runtime, or explicitly ask before aborting it and record the interruption. Hiding a pane must not be equivalent to silently terminating its process.

**Relevant code**

- `src/App.tsx`: switching `view` replaces the whole `.chat-workspace`, including `SplitChatPane`, with `SettingsView` while retaining `splitPane` state
- `src/components/SplitChatPane.tsx`: the effect cleanup always calls `runtimePool.release(transport)`, whose disposal stops Pi
- `src/lib/sessionRuntimePool.ts`: `release` removes the runtime and calls `transport.dispose()` regardless of whether its turn is active

### WDIO-057 — Visiting Settings silently deletes unsent split-pane attachments

**Severity:** Medium

**Reproduction**

1. Open a conversation in the split pane.
2. Add a file attachment and type an unsent text draft in the split composer.
3. Open **Settings**, then immediately return to chat without editing or saving anything.
4. Inspect the split composer.

I attached an in-memory text file named `qa-split-draft.txt` through the split pane's real file input and entered `draft survives, attachment should too` in its composer.

**Observed**

The text draft survived the round trip, but `qa-split-draft.txt` and its **Remove qa-split-draft.txt** control were gone. No warning or notice was shown. This makes the loss especially easy to miss: the composer looks restored, but sending it omits the file the user had deliberately queued.

The split draft is stored by App in `composerDrafts`, while split uploads are local `useState` inside `SplitChatPane`. Opening Settings unmounts that component, so the attachment state is destroyed; returning mounts a fresh pane with an empty upload list.

**Expected**

Unsent split attachments should survive non-destructive navigation just like the split text draft, or the app should warn before discarding them.

**Relevant code**

- `src/App.tsx`: `setSplitComposerDraft` persists split text in application-level state, but no corresponding split-upload state is retained
- `src/components/SplitChatPane.tsx`: `uploads` is component-local state initialized to `[]`
- `src/App.tsx`: Settings replaces and unmounts the chat workspace, then remounts the retained split session on return

### WDIO-058 — The keybinding recorder captures Tab and traps keyboard focus

**Severity:** Medium

**Reproduction**

1. Open **Settings → Keybinds** using only the keyboard.
2. Focus any shortcut field, such as **New conversation shortcut**.
3. Press Tab to move to the next control.

**Observed**

The field changed from `Ctrl+N` to `Tab`, the key event was default-prevented, and focus remained on **New conversation shortcut**. The edited value was treated as a valid dirty setting and Save remained available. Shift+Tab follows the same generic capture path as `Shift+Tab` rather than providing backward focus navigation.

If saved, the bare `Tab` binding also matches in App's window-level shortcut listener, which prevents the event's default behavior before running the assigned action. A user can therefore both become trapped while configuring the shortcut and disable ordinary forward keyboard navigation throughout the application.

**Expected**

Tab and Shift+Tab must retain their platform focus-navigation behavior in the recorder and should not be accepted as global shortcuts.

**Relevant code**

- `src/components/SettingsView.tsx`: `KeybindInput` prevents every keydown before deciding whether the key is suitable for a shortcut
- `src/lib/keybindings.ts`: `shortcutFromEvent` rejects unmodified one-character keys but accepts multi-character navigation keys such as `Tab`
- `src/App.tsx`: a matching global shortcut calls `event.preventDefault()` before invoking its action

### WDIO-059 — Restoring already-default shortcuts creates a false unsaved change

**Severity:** Low

**Reproduction**

1. Start with all six keybindings at their defaults.
2. Open **Settings → Keybinds** and confirm **Save changes** is disabled.
3. Record the displayed values, then click **Restore defaults**.

**Observed**

The values remained exactly `Ctrl+N`, `Ctrl+B`, `Ctrl+J`, `Ctrl+D`, `Ctrl+L`, and `Ctrl+,`, but **Save changes** became enabled. Attempting to leave also produced the unsaved-settings confirmation. Saving this non-change would invoke the full settings persistence and runtime-restart path.

The settings loaded from disk contained the same key/value pairs in a different property insertion order from `defaultKeybindings`. Dirty detection serializes the objects directly, so replacing the map with the canonical defaults changes the JSON string even though every effective shortcut is identical.

**Expected**

Restoring defaults when the effective values are already default should remain clean. Settings equality should not depend on object property order.

**Relevant code**

- `src/components/SettingsView.tsx`: **Restore defaults** replaces the keybinding object with `defaultKeybindings`
- `src/components/SettingsView.tsx`: dirty state compares `JSON.stringify(settingsSnapshot(...))` output rather than semantic key/value equality
- `src/lib/keybindings.ts`: `defaultKeybindings` is constructed in definition order, which need not match persisted JSON property order

### WDIO-060 — Overlapping file reads silently replace an earlier attachment selection

**Severity:** Medium

**Reproduction**

1. In one composer, select a batch of files.
2. Before that batch's asynchronous `FileReader` work settles and rerenders the composer, select another batch.
3. Wait for both operations and inspect the attachment chips.

For a deterministic check, I dispatched two back-to-back selections containing eight distinct tiny text files each: `race-a-1.txt`…`race-a-8.txt` and `race-b-1.txt`…`race-b-8.txt`.

**Observed**

Only the eight `race-b-*` chips remained. Every valid `race-a-*` attachment disappeared, and no attachment-limit or read error was shown. Depending on file-read completion order, either selection can overwrite the other, so a larger/slower file selected first can also erase a later small attachment after the user has already seen it appear.

`addFiles` correctly asks `updateUploads` for a functional append, but `updateUploads` immediately evaluates that function against the `uploads` prop captured by the current render. It then sends a concrete array to App. Concurrent readers therefore both append to the same stale baseline instead of composing their updates atomically.

**Expected**

Selections that overlap during file reading should be merged against the latest upload state, with the count and byte limits enforced on the combined result. No accepted attachment should disappear without an explicit user removal or visible error.

**Relevant code**

- `src/components/Composer.tsx`: `addFiles` awaits one `FileReader` per file, allowing multiple invocations to overlap
- `src/components/Composer.tsx`: `updateUploads` evaluates functional updates as `update(uploads)` using the render-time controlled prop
- `src/App.tsx`: main uploads are stored in `uploadsByTransport`, but its callback receives only the already-materialized replacement array
