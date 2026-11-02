I found these machine-specific or hard-coded items. I did not change anything.

Your personal setup forced on others

reinstall-mobile.mjs:
It signs release builds with the debug key.
Version and setup assumptions (Debian/Ubuntu and Android are accepted)

tauri.conf.json: its dependencies are libasound2t64 and gstreamer >= 1.28, which only very new Ubuntu or Debian releases have.
Tests need a real pi on your PATH or in ~/.local/bin (wdio.conf.ts, test/skill-mcp-session-fixture.mjs).
mobile-debug-connection.mjs:95: 10.0.2.2 works only from the Android emulator, not from a real phone.
