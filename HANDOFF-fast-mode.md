# Fast-mode refactor handoff

Ownership, scan timing, and the public interfaces are defined; implementation remains. The user-edited [ADR 0003](docs/adr/0003-separate-fast-model-discovery-from-session-state.md) is authoritative.

## Decisions

- A separate module owns fast-model discovery. Host provider scanning code calls its public interface. Settings, drafts, and agent validation use host results without needing a Pi session.
- Run regular and fast-model scans at daemon startup and whenever an existing trigger starts an actual provider-model scan. Ordinary checks share the five-minute limit per host; startup starts it. Explicit Refresh bypasses it. Adding a provider scans that provider immediately. There is no periodic scan timer.
- Fast-model scans include supported built-in providers; regular scans currently target custom providers. Keep these provider filters separate.
- Keep discovery results separate by host and applicable provider/account/configuration context. Report failures and retain the last successful results.
- The Pi fast-mode extension owns the session's saved on/off choice and provider request changes. It neither depends on discovery nor checks support. It exposes no `supported` or `active` state. Pi owns the current model.
- Client state changes follow: client → transport → daemon → session broker → fast-mode session interface inside Pi. Other extensions use this same interface instead of saving fast-mode state themselves.

## Agreed session interface

```ts
interface FastModeSession {
  getEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  subscribe(
    listener: (enabled: boolean) => void,
    onError: (error: Error) => void,
  ): () => void;
}
```

Save before reporting success; a failed save leaves the choice unchanged. Subscribe sends the initial choice and subsequent changes, and returns an unsubscribe function.

## Discovery interface

The contract is saved in [fast-model-discovery.proposed.ts](daemon/resources/fast-model-discovery.proposed.ts). It is not connected to runtime code yet.

```ts
type FastModelScanResult =
  | { provider: string; status: "ok"; supportedModelIds: readonly string[] }
  | { provider: string; status: "error"; message: string };

interface FastModelDiscovery {
  scan(provider?: string): Promise<readonly FastModelScanResult[]>;
}
```

Each instance uses one host's model runtime and authentication. `scan()` checks all registered providers the module supports, including built-ins; `scan(provider)` checks one provider. Every call attempts discovery. The host owns the refresh limit, saved results, and client updates.

Each attempted provider returns one result with unique model IDs. Success replaces its saved list, including an empty list. An error preserves previous results for the same account/configuration context and is reported. Discard results if that context changes during the scan. Unsupported providers produce no result; unknown providers produce an error. Failures that prevent the entire scan reject the promise.

## Remaining work

Implement the discovery and session interfaces and connect both paths. The earlier `extensions/piop-openai-fast-mode/src/interface.proposed.ts` is outdated: its combined support/session contract is superseded by this decision. Session-broker request names and interface registration are not finalized.

Start with `daemon/src/host/providers.ts`, `daemon/resources/fast-capabilities.mjs`, `extensions/piop-openai-fast-mode/src/`, and `extensions/piop-define-agents/`. Check drafts, settings, child-session inheritance, and UI callers when moving ownership.

Keep the user's glossary removals. Tests must not survive merges into dev or main.
