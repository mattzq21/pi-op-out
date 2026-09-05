# Pi orchestration extension

Owns ordered sequences, foreground/background handoff, and orchestrator-gated delegation for Pi CLI and piop. Requires the separately loaded `pi-define-agents` extension for agent definitions and application.

Install both extensions from this repository:

```bash
mkdir -p ~/.pi/agent/extensions/pi-define-agents ~/.pi/agent/extensions/pi-orchestration
cp extensions/pi-define-agents/index.ts ~/.pi/agent/extensions/pi-define-agents/index.ts
cp extensions/pi-orchestration/index.ts ~/.pi/agent/extensions/pi-orchestration/index.ts
```

Reload Pi. If `pi-define-agents` is missing, orchestration reports the missing dependency and stays disabled; Pi remains usable. Either extension discovery order works. piop provisions both extensions on remote hosts.

Agent definitions live in `pi-define-agents/config.json`. This extension's `config.json` contains only sequences, which reference defined agents by name. See `config.example.json`. On upgrade, `pi-define-agents` moves agents out of the old combined file and preserves `config.json.pre-define-agents.bak`; see its README for migration details. Invalid JSON is reported without overwriting the file. Legacy desktop-owned YAML/settings migration is not supported.

Use `/pi-define-agents-use reviewer` for an individual agent. Use `/pi-orchestration-use review-sequence`, `/pi-orchestration-use final-only`, or `/pi-orchestration-use own+final` for orchestration. The older `/pi-orchestration-use reviewer` remains accepted when both extensions are loaded. Existing session selections and sequence handoffs remain readable.

Final-only children receive the original request plus chronological final messages; own+final children additionally receive their own prior requests. Child processes load `pi-define-agents` to enforce the same agent tool restrictions. Orchestration owns spawning, cancellation, and foreground/background sequence state.

piop discovers sequences and multi-agent modes through the orchestration status, independently of agent discovery. `/pi-orchestration-config <base64url-json>` saves `{ "sequences": [...] }`; definitions are saved through `/pi-define-agents-config`. Unknown agent references are rejected on save. If an agent is later removed independently, its sequence is preserved and cannot run the missing step.
