---
name: piop-wdio
description: Manually inspect and interact with Piop app.
---

# Manual UI testing with WDIO MCP

Use the `piop-wdio` MCP tools.

1. Call `launch` with the absolute Piop worktree path. It starts the app and attaches WDIO to it.
2. The tools let you:
   - Inspect elements and DOM with `get_elements`.
   - Inspect DOM state and execute page JavaScript with `execute_script`.
   - Interact with the app: click, drag and drop, enter text, scroll.
   - Capture screenshots with `get_screenshot`.
3. Call `stop` when finished.

Use the current tool schemas and live UI state to choose interactions, then inspect the result and so on.
