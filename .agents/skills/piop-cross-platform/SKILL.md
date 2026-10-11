---
name: piop-cross-platform
description: Test Piop simultaneously on PC and Android using piop-wdio and mobile-piop.
---

# Piop on desktop and Android

Use the `piop-wdio` MCP tools for desktop and the `mobile-piop` MCP tools for Android.

1. Both servers start their app before the chat begins.
2. Test the requested flow on both platforms. Do the matching steps one after the other and inspect the live UI after each interaction. Remember that both apps share the worktree's daemon, so an action on one platform can change the other.
3. Report the result on each platform and any differences or blockers.
