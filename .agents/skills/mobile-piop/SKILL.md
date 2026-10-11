---
name: mobile-piop
description: Manually inspect and interact with Piop's Android app in a private Android VM.
---

# Manual UI testing in an Android VM

Use the `mobile-piop` MCP tools. Their server builds the app and starts it in a private VM before the chat begins, so the app is ready.

The tools let you:

- Inspect the UI, including WebView text, with `ui_hierarchy` and `find_elements`.
- Tap, type, swipe, scroll, drag, rotate, and hide the keyboard.
- Read the app state with `app_state`.
- Capture screenshots with `screenshot`.
- Run commands in the VM with `exec`.
- Rebuild and restart the app after code changes with `reinstall`.

Use the current tool schemas and live UI state to choose interactions, then inspect the result and so on.
