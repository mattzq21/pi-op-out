---
status: accepted
---

# Own context caps in the Pi extension

The context-cap extension owns the session's chosen cap, priority rules, validation, deferred changes, and saved history. Pi owns the selected model and its original context window. The extension applies the effective window through `model.contextWindow`; Pi uses that value for context usage and its own compaction checks.

## Choice and priority

Resolve in this order: manual session choice → active agent definition → provider/model config → general config → Pi model default. Place the provider/model setting next to its toggle in settings. Model default means Pi's original window, including the discovered value for custom providers.

- `/cap 500k` sets a manual numeric choice. Accept numbers with up to two decimal places and optional `k` or `m`, using decimal multipliers of 1,000 and 1,000,000. `/cap 0.75m` means 750,000 tokens.
- `/cap reset` clears the manual choice and resolves the remaining priorities.
- `/cap model_default` sets a manual `null` choice, bypassing all cap settings.
- In defaults, an omitted value inherits; `null` selects the model default and stops fallback.

A manual choice survives model changes. When switching to a smaller model, retain that choice and apply the smaller window. Switching back restores the chosen cap. A new numeric choice above the current model's original window is rejected; this differs from clamping an existing manual choice after a model switch.

## Validation and timing

Numeric values must be whole safe integers after parsing, between 100,000 and 50,000,000 tokens inclusive. Reject malformed input, values outside that range, and new choices above the current model's window. Require the applied window to exceed Pi's reserved response tokens plus its recent-history token budget. Apply the same validation to agent definitions and settings. `reset` and `model_default` are operations, not numeric inputs; a model default is not subject to the numeric cap range.

Errors must be clear and leave the previous choice unchanged. Validate on receipt and again before saving and applying a deferred change.

Apply changes only at idle: before a task starts or after the agent settles, with no answer generation, tool execution, or history compaction in progress. Follow-ups and goals can remain queued. Apply cap changes before starting that queued work.

All change operations share one queue per session, ordered by receipt at the extension. Process each separately; do not collapse them into the last change. A failed operation reports its error and leaves state unchanged; later operations continue. A reset uses defaults from earlier successful operations. Provider/model and general config edits update existing sessions at idle when no manual choice overrides them. The agent definition is loaded once at agent start and stays fixed for the session, including on resume; later definition edits apply only to new agents.

## Application and history

Apply on cap changes and `model_select`. Changes also include session/branch restoration, relevant provider/model and general config updates, and a model refresh replacing the current model object. Write the model field only when needed. These paths replace repeated application on input and before agent start. Retain `session_shutdown` to restore original model values and remove listeners, including during extension reload.

Append one custom entry for each effective cap or source change in the session JSONL. Sources are `manual`, `agent_definition`, `config`, and `modelMax`. Model and general settings both use `config`.

```json
{"type":"custom","customType":"piop-context-cap","data":{"cap":200000,"source":"modelMax"}}
```

`modelMax` records only the effective clamped window. It does not replace the chosen manual cap: the earlier choice entry remains in history. Do not append an extra manual entry when clamping. `null` records use of the model default; `/cap model_default` uses source `manual`. Restore from the current branch and recover the preceding choice when the latest entry is `modelMax`. Rejected changes produce no cap entry.

## Interface

Use the proposed `ContextCapSession` interface in `extensions/piop-context-window-cap/interface.proposed.ts`: `getState`, `setManualCap`, `resetManualCap`, `updateDefaults`, and `subscribe`. State separates the chosen `cap` and its source from `appliedWindow`. `modelMax` is a log source for clamping, not the source of the chosen cap.

Client requests pass through transport, daemon, and session broker to the extension instance inside Pi. The broker supplies complete agent, provider/model, and general defaults through `updateDefaults`. Change promises finish after saving and applying; subscribers receive initial state and effective changes. The extension reports failures explicitly.

This is a design decision; runtime implementation remains.
