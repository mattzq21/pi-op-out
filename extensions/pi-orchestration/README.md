# Pi orchestration extension

Owns named agents, ordered sequences, foreground/background handoff, and orchestrator-gated delegation for Pi CLI and Pi Desktop.

Install it globally:

```bash
mkdir -p ~/.pi/agent/extensions/pi-orchestration
cp index.ts ~/.pi/agent/extensions/pi-orchestration/index.ts
```

The extension creates `config.json` beside itself on first load. A missing configuration is initialized with the default agent configuration; unreadable or invalid JSON is reported without overwriting the file. Valid JSON is normalized on load. Legacy desktop-owned YAML/settings migration is not supported. `config.example.json` documents the current JSON format for manual configuration.

Pi Desktop discovers the extension through its RPC capability status. Agent, sequence, and multi-agent controls remain hidden when the extension is not loaded. The same extension and configuration work in Pi CLI; use `/pi-orchestration-use reviewer`, `/pi-orchestration-use review-sequence`, `/pi-orchestration-use final-only`, or `/pi-orchestration-use own+final` to select a target there. Final-only children receive the original request plus chronological final messages; own+final children additionally receive their own prior requests.

Agent tool declarations are strict. Every name in an agent's `tools` array must be available in Pi and allowed by Pi Desktop's global tool settings or the CLI's tool flags. A direct run is stopped with an error before inference when any declaration is denied or unavailable; orchestrated child runs exit with failure.
