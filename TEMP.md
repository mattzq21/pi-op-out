I found these machine-specific or hard-coded items. I did not change anything.

Paths and tools from your own machine

extensions/piop-define-agents/README.md:39: /home/matt/Projects/cua-vm-broker/cua-vm-broker.
The Android Studio Java folder is guessed as ~/Applications/android-studio/jbr in reinstall-mobile.mjs:32.
Your personal setup forced on others

reinstall-mobile.mjs:
The bun run reinstall command needs Tailscale (a private network tool).
It runs sudo tailscale serve --https=443, which takes over port 443 for Tailscale Serve on that machine.
It signs release builds with the debug key.
CustomProviderForm.tsx:7: a "Go broker preset" for 127.0.0.1:8787 (your own local service) shows to all users.
profiles.ts:8: the bundled agents workhorse and reviewer are set to openai/gpt-6-luna. Users without OpenAI get agents that do not work.
Web search defaults to gpt-6.1-sol (OpenAI) in daemon/plugins/web-search.
prompts.ts:296: default prompt files go in ~/.agents/.... The app creates them in the user's home folder.
Distro or hardware assumptions

tauri.conf.json:
It builds only a .deb package.
Its dependencies are libasound2t64 and gstreamer >= 1.28, which only very new Ubuntu or Debian releases have.
reinstall-desktop.mjs: uses dpkg, sudo, and stops /usr/bin/piopd.
test/webkit/webdriver.mjs:12: MiniBrowser is at a fixed /usr/lib/x86_64-linux-gnu/... path. You can change it with an environment variable.
Tests need:
systemd-run --user (scripts/test-run.py)
Xvfb
WebKitWebDriver
a real pi on your PATH or in ~/.local/bin (wdio.conf.ts, test/skill-mcp-session-fixture.mjs)
mobile-debug-connection.mjs:95: 10.0.2.2 works only from the Android emulator, not from a real phone.
