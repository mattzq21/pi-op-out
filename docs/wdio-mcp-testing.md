# Handy manual testing with WDIO MCP

Use WDIO MCP for short, user-visible checks: click the app as a user would, verify the resulting state, and save a screenshot as evidence. Use the automated suite (`npm run test:e2e`) for repeatable regression coverage.

## 1. Prepare once

Build the WebDriver-enabled release app:

```bash
npm run test:e2e:build
```

Start a WebDriver session for `src-tauri/target/release/pi-desktop`, then attach WDIO MCP to that session. When delegating this to Codex, a useful request is:

> Use WDIO MCP with the WebDriver-enabled release binary. Test these scenarios manually, take one screenshot after each verified result, restore state, and close the session.

Keep the same session for related checks. Reload between scenarios when their mocked backend or conversation state could leak.

## 2. Follow this loop for each scenario

1. State one observable expectation, such as “switching conversations restores each draft.”
2. Inspect the current UI with the accessibility tree or element listing.
3. Use `click_element` and `set_value` for normal user actions.
4. Read the resulting text, values, element counts, or recorded backend calls.
5. Only after the expectation passes, call `get_screenshot` and save it with a numbered descriptive name.
6. Clear temporary input, dialogs, panels, search filters, and backend mocks.

Good screenshot names make failures easy to review:

```text
001-essential-controls.png
002-draft-restored.png
003-terminal-tabs-isolated.png
```

## 3. Mock the backend when needed

WebDriver builds expose two hidden test bridges:

- `textarea[aria-label="E2E responses"]` contains mocked command responses as JSON.
- `textarea[aria-label="E2E calls"]` records commands issued by the UI.

Set calls to `[]`, install only the responses the scenario needs, perform the interaction, then inspect the call log. Existing examples are in [conversation.acceptance.spec.ts](../test/e2e/specs/conversation.acceptance.spec.ts).

Some state changes also require a Pi event:

```js
await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
  event: "pi://event",
  payload: { type: "session_switched" },
});
```

Prefer dedicated WDIO actions. Use `execute_script` only for test-bridge setup, synthetic events, or controls that cannot be driven reliably through a normal click.

## 4. Useful shortcuts

- Inspect first; stable ARIA labels are better selectors than CSS layout classes.
- On the Linux WebKit driver, native JavaScript value setters plus an `input` event can be faster for large JSON bridge values.
- Batch related setup and verification in one asynchronous script, but keep the actual scenario understandable.
- If the app becomes blank after reconnecting or replacing mocks, reload and reapply the scenario setup.
- For hover-only actions, reveal the session controls first; use a scripted click only as a last resort.
- Never overwrite real Pi settings or orchestration data without making and restoring an exact backup.

## 5. Finish cleanly

Before reporting success:

- Confirm every expected screenshot exists, is a non-empty PNG, and has a unique number.
- Reset the E2E response and call bridges.
- Reload the app and confirm no dialog, split pane, terminal, toast, or draft remains from the test.
- Restore any backed-up native configuration and verify the repository is clean.
- Close the WDIO session and stop its driver process.

The reusable selectors and interaction style live in [app.page.ts](../test/e2e/pageobjects/app.page.ts); copy those conventions when a manual check becomes a permanent automated test.
