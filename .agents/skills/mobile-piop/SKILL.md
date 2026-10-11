---
name: mobile-piop
description: Manually inspect and interact with an Android app in a private Android VM.
---

# Manual UI testing in an Android VM

Use the agent's shell tool with `tty: true` to run this, and keep its session open:

```bash
python3 ~/.agents/skills/mine/mobile-piop/scripts/setup-debug.py --project "$PWD"
```

It builds the app, starts it in a private VM, and prints a `sessionFile`. Use it for all calls:

```bash
python3 ~/.agents/skills/mine/mobile-piop/scripts/setup-debug.py tools --session /absolute/session.json
python3 ~/.agents/skills/mine/mobile-piop/scripts/setup-debug.py call --session /absolute/session.json TOOL '{}'
```

The tools let you:

- Inspect the UI, including WebView text, with `ui_hierarchy` and `find_elements`.
- Tap, type, swipe, scroll, drag, rotate, and hide the keyboard.
- Read the app state with `app_state`.
- Capture screenshots with `screenshot`.
- Run commands in the VM with `exec`.
- Rebuild and restart the app after code changes with `reinstall`.

Use the current tool schemas and live UI state to choose interactions, then inspect the result and so on.
