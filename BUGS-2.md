# Additional UI bugs

Manually reproduced on 2026-09-03 with WDIO MCP against a freshly rebuilt WebDriver-enabled release app. The test window was 1,440 × 937. Every finding was checked through an observable DOM/backend-call result and captured in a screenshot during the run.

## 1. Simultaneous error and notice toasts completely overlap

- **Severity:** Medium
- **Reproduction:** Keep an extension warning visible, then trigger an application error, such as a failed attempt to create a temporary conversation.
- **Observed:** Both `.error-toast` elements render at exactly `x=74`, `y=869`, with the same 390 × 52 px footprint. The later extension warning covers the connection error, including most of its close control, so the more important failure is not readable.
- **Expected:** Concurrent notifications should be stacked, queued, or consolidated so every message and close control remains visible.
- **Evidence:** The DOM contained both `Pi could not connect — Temporary chat deliberately failed` and `Extension warning — Review the generated changes`, with identical bounding rectangles. A screenshot was captured after both appeared.

## 2. Extension requests can be hidden behind the Open project dialog

- **Severity:** High
- **Reproduction:** Open the project picker, then emit an interactive extension confirmation before closing it.
- **Observed:** Two modal backdrops and two `aria-modal` dialogs are mounted at once. Both backdrops use the same z-index. The project picker is later in document order and completely covers the extension confirmation, leaving the extension request pending with no visible indication that it exists.
- **Expected:** Application dialogs and extension dialogs should share one modal queue, or the active dialog should visibly yield to the new request without leaving two modal focus scopes mounted.
- **Evidence:** The DOM simultaneously contained `Confirm extension action` at `x=505, y=380.5` and `Open project` at `x=505, y=314.25`; the screenshot showed only the project picker.

## 3. A failed extension response silently closes the dialog and loses input

- **Severity:** High
- **Reproduction:** Show an extension input request, enter `release-candidate`, make `pi_command:extension_ui_response` reject, and click Continue.
- **Observed:** The response command is issued with the entered value, but the dialog immediately disappears. No toast or inline error is shown, and the entered value cannot be recovered or retried.
- **Expected:** Keep the dialog and its current value open until the response succeeds. If sending fails, show an actionable error and allow retry or cancellation.
- **Evidence:** The recorded mocked call contained `extension_ui_response` with `value: "release-candidate"`; immediately afterward the page contained zero dialogs and zero toasts. A screenshot captured that empty post-failure state.

## 4. Enter submits a raw slash instead of activating the selected command

- **Severity:** Medium
- **Reproduction:** Focus the composer, type `/`, observe that `/compact` is marked `aria-selected="true"`, then press Enter.
- **Observed:** The palette closes, the composer clears, and the backend receives a normal prompt whose message is exactly `/`. The selected `/compact` command is not inserted or run. This reproduced on both attempts.
- **Expected:** Enter should activate the currently selected palette item, consistent with standard keyboard menu behavior. Raw submission should require dismissing the palette or otherwise be explicit.
- **Evidence:** The pre-action screenshot shows `/compact` selected. The recorded call after Enter was `pi_command` with `{ type: "prompt", message: "/" }`.

## 5. Global layout shortcuts execute behind modal dialogs

- **Severity:** Medium
- **Reproduction:** Open the project picker, then press the configured `Ctrl+B` shortcut.
- **Observed:** The project picker stays open, but the conversation sidebar disappears behind it. The DOM changes from a visible `.session-panel` to no session panel while the modal remains mounted. Other global shortcuts use the same unguarded window-level handler and can similarly mutate hidden application state.
- **Expected:** While a modal is active, application-level shortcuts should be suspended except for dialog-specific actions such as Escape, or explicitly routed to the active dialog.
- **Evidence:** After `Ctrl+B`, the DOM still contained the dialog but no `.session-panel`; the screenshot shows the project picker over the changed background layout.
