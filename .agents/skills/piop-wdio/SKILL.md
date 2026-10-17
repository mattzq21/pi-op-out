---
name: piop-wdio
description: Manually inspect and interact with Piop app.
---

# Manual UI testing with WDIO MCP

Use the agent's shell tool to run this:

```bash
python3 ~/.agents/skills/mine/piop-wdio/scripts/tauri-webdriver.py --project "$PWD"
```



WDIO MCP lets you:

- Inspect elements and DOM with `get_elements`
- Inspect DOM state and execute page JavaScript with `execute_script`
- Interact with the app: Click, tap, swipe, drag and drop, enter text, scroll.
- Capture screenshots with `get_screenshot`.

Use the current tool schemas and live UI state to choose interactions, then inspect the result and so on.
