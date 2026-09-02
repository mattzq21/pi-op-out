# More UI bugs

Manually reproduced on 2026-09-03 with WDIO MCP against a freshly rebuilt WebDriver-enabled release app. The test window was 1,440 × 937. Every finding was checked through an observable DOM/backend-call result and captured in a screenshot during the run.

## 1. A failed conversation rename silently closes the dialog and loses the new name

- **Severity:** Medium
- **Reproduction:** Open a conversation's context menu, choose **Rename conversation**, enter a new name, make `pi_command:set_session_name` reject, and click Continue.
- **Observed:** The rename command is issued with the entered value, but the dialog closes immediately. No error toast or inline message appears, the sidebar keeps the old name, and the user's new name cannot be recovered or retried.
- **Expected:** Keep the dialog and entered name available until the rename succeeds. If saving fails, show an actionable error and allow retry or cancellation.
- **Evidence:** The mocked backend received `{ type: "set_session_name", name: "Name that will be lost" }`; afterward the DOM contained zero dialogs and zero toasts, while the sidebar still showed `More rename target`. A screenshot captured the post-failure state. The dialog is cleared before the command resolves in `src/App.tsx:343`, and the promise has no rejection handler.

## 2. Fresh unsaved conversations inherit each other's draft and terminal state

- **Severity:** High
- **Reproduction:** Start a new conversation, enter an unsent draft, open the terminal and add a second terminal tab, then click **New conversation** again before either conversation has a persisted session ID.
- **Observed:** The next fresh conversation contains the previous conversation's full draft. Its terminal panel also retains both terminal tabs, and starting a terminal reuses the same terminal ID under the new working directory.
- **Expected:** Each temporary/new conversation should receive a unique identity immediately so its composer draft, uploads, and terminal processes cannot leak into another conversation.
- **Evidence:** After two distinct `create_temporary_chat` calls, the composer still contained `draft that belongs to the first new chat`, and the terminal header still showed `Terminal` and `Terminal 2`. Recorded `start_terminal` calls reused one terminal ID first with `/tmp/pi-ui-more-second` and then `/tmp/pi-ui-more-third`. Screenshots captured both the inherited draft and inherited two-tab terminal panel. `src/App.tsx:84` maps every session without an ID to the same `${activeHostId}:new-session` key, which backs both drafts and terminal state.

## 3. A failed terminal close removes the tab from the UI and can orphan the process

- **Severity:** High
- **Reproduction:** Open two terminal tabs, make `close_terminal` reject, and delete the second tab.
- **Observed:** The backend close request fails, but the tab disappears from the terminal panel anyway. No error is shown, so the user loses access to a terminal process that may still be running.
- **Expected:** Remove the tab only after the backend confirms that the terminal closed, or restore the tab and display an actionable failure message.
- **Evidence:** The mocked backend received `close_terminal` for the second terminal and rejected it with `Terminal close deliberately failed`; the DOM immediately changed from two tabs to one and contained no toast. A screenshot captured the missing tab. `src/App.tsx:302-304` suppresses the rejection and removes the tab synchronously.

## 4. A failed agent selection provides no feedback

- **Severity:** Medium
- **Reproduction:** Expose `default` and `reviewer` orchestration agents, make the prompt used to select an agent reject, open the Agent picker, and choose `reviewer`.
- **Observed:** The active agent remains `default`, but the picker closes and no toast or inline error explains that the change failed.
- **Expected:** Report the failed agent change and either keep the picker open or otherwise leave an obvious retry path.
- **Evidence:** The mocked backend received `/pi-orchestration-use InJldmlld2VyIg`, the Agent control still displayed `default`, and the DOM contained no error toast. A screenshot captured the unchanged post-failure state. `src/App.tsx:264` lets the command rejection escape without presenting it to the UI.

## 5. Debug mode remains enabled in the UI after settings persistence fails

- **Severity:** Medium
- **Reproduction:** Make `save_app_settings` reject, then click **Enable debug mode** in the navigation rail.
- **Observed:** The rail immediately changes to **Disable debug mode** and debug-only UI appears even though the save failed. A toast reports `Settings persistence deliberately failed`, but the optimistic state is not rolled back, leaving the running UI inconsistent with the stored settings.
- **Expected:** Roll back the toggle when persistence fails, or clearly mark the setting as unsaved and provide a retry action.
- **Evidence:** After the mocked rejection, the toggle's accessible label was `Disable debug mode` and the DOM simultaneously contained the persistence error toast. A screenshot captured both. `src/App.tsx:309-313` updates local state before saving and handles rejection only by setting an error.
