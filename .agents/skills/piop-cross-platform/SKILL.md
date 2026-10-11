---
name: piop-cross-platform
description: Test Piop simultaneously on PC and Android using piop-wdio and mobile-piop.
---

Read and follow both `~/.agents/skills/piop-wdio/SKILL.md` and `~/.agents/skills/mobile-piop/SKILL.md`.

Start both skills' launcher scripts concurrently for the same project/worktree and keep both processes running throughout testing. Use each launcher's own session details and current tool schemas.

Test the requested flow on both platforms, interleaving corresponding steps and inspecting live UI state after each interaction. Account for shared backend state when an action on one platform affects the other. Compare behavior and report results for each platform, including any differences or blockers.