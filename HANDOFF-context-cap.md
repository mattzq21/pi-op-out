# Context-cap refactor handoff

Implement [ADR 0004](docs/adr/0004-session-context-cap-interface.md). It records the accepted commands, priority, validation, queue order, hooks, and effective-change log. Runtime code has not been refactored yet.

## Public interface

Start from [interface.proposed.ts](extensions/piop-context-window-cap/interface.proposed.ts). It has:

- `getState()` — chosen cap/source and applied window.
- `setManualCap(number | null)` — numeric `/cap` or `/cap model_default`.
- `resetManualCap()` — clear manual choice and resolve defaults.
- `updateDefaults({ agentDefinition, modelConfig, generalConfig })` — complete defaults from the session broker.
- `subscribe(listener, onError)` — initial state and effective changes; returns unsubscribe.

The proposal's final comment saying the log schema is open predates the ADR. Follow the ADR's `piop-context-cap` entries and `modelMax` rule. Preserve the difference between chosen state and the effective window.

## Implementation points

- `extensions/piop-context-window-cap/index.ts`: currently saves the initial cap under `piop-session-context-cap`, reads the first matching entry, and repeatedly changes model objects. Replace this with the agreed session interface and current-branch restore rules.
- `extensions/piop-runtime-settings/index.ts` and the session broker: deliver defaults and public requests. Final request names and interface registration still need to be chosen.
- Agent definitions and settings: add cap fields, validation, and the provider/model setting next to its toggle. Send complete defaults after relevant agent/model/config changes.
- Apply the chronological queue at idle before queued follow-ups or goals start. Reject unfinished operations on session shutdown. Preserve shutdown cleanup for reload.

## Verification

Check numeric parsing and bounds, compaction budgets, defaults and reset, invalid changes preserving state, queued order, and settings edits on existing sessions. Check model switch 500k → 200k → 1m: the applied window changes 500k → 200k → 500k while the manual choice remains 500k.

Check reopen, branch navigation, and extension reload, including reset or source changes that leave the numeric window unchanged. Effective-only logging must still restore the correct choice. If the agreed entries cannot represent a case, identify it before changing the schema. Also resolve how to report a model switch whose native window cannot fit Pi's compaction budgets; the numeric clamp exception does not make those budgets fit.

Follow the current AGENTS instructions. No compatibility path is required. The former instruction to remove tests before merge was replaced and is no longer in force.
