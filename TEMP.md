I found these machine-specific or hard-coded items. I did not change anything.

Paths and tools from your own machine

Your personal setup forced on others

reinstall-mobile.mjs:
The bun run reinstall command needs Tailscale (a private network tool).
It runs sudo tailscale serve --https=443, which takes over port 443 for Tailscale Serve on that machine.
It signs release builds with the debug key.
CustomProviderForm.tsx:7: a "Go broker preset" for 127.0.0.1:8787 (your own local service) shows to all users.
profiles.ts:8: the bundled agents workhorse and reviewer are set to openai/gpt-6-luna. Users without OpenAI get agents that do not work.
Web search defaults to gpt-6.1-sol (OpenAI) in daemon/plugins/web-search.
prompts.ts:296: default prompt files go in ~/.agents/.... The app creates them in the user's home folder.
Version and setup assumptions (Debian/Ubuntu and Android are accepted)

tauri.conf.json: its dependencies are libasound2t64 and gstreamer >= 1.28, which only very new Ubuntu or Debian releases have.
Tests need a real pi on your PATH or in ~/.local/bin (wdio.conf.ts, test/skill-mcp-session-fixture.mjs).
mobile-debug-connection.mjs:95: 10.0.2.2 works only from the Android emulator, not from a real phone.
