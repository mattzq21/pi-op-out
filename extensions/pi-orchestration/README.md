# Pi orchestration extension

Owns named agents, ordered sequences, foreground/background handoff, and orchestrator-gated delegation for Pi CLI and Pi Desktop.

Install it globally:

```bash
mkdir -p ~/.pi/agent/extensions/pi-orchestration
cp index.ts ~/.pi/agent/extensions/pi-orchestration/index.ts
```

The extension creates `config.json` beside itself on first load. If the previous desktop-owned configuration exists in `~/.pi-desktop/agents` and the Pi Desktop settings file, it migrates those agents and sequences without deleting the old files. `config.example.json` documents the file format for a fresh manual configuration.

Pi Desktop discovers the extension through its RPC capability status. Agent, sequence, and orchestrator controls remain hidden when the extension is not loaded. The same extension and configuration work in Pi CLI; use `/pi-orchestration-use reviewer`, `/pi-orchestration-use review-sequence`, or `/pi-orchestration-use orchestrator` to select a target there.

Agent tool declarations are strict. Every name in an agent's `tools` array must be available in Pi and allowed by Pi Desktop's global tool settings or the CLI's tool flags. A direct run is stopped with an error before inference when any declaration is denied or unavailable; orchestrated child runs exit with failure.
