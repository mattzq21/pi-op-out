---
status: accepted
---

# Separate fast-model discovery from session state

Settings, drafts, and agent validation need fast-model support information without a running Pi session. A separate fast-model discovery module owns this information and exposes a public interface to the host's provider scanning code. The fast-mode Pi extension owns only the session's saved on/off choice and provider request changes, so discovery failures do not prevent it from restoring or changing that choice.

Run regular provider-model scans and fast-model scans at daemon startup. Whenever an existing trigger starts an actual provider-model scan, also call the fast-model discovery interface. Ordinary refresh checks share the existing five-minute limit per host; startup starts that limit, explicit Refresh bypasses it, and adding a provider scans that provider immediately. The limit is not a periodic scan timer. Fast-model discovery covers its supported providers, including built-in providers; it must not inherit the regular scan's custom-provider-only filter.

The host stores and exposes discovery results for settings, drafts, and validation. Keep results separate by host and applicable provider/account/configuration context. Report scan failures and retain the last successful results rather than treating failure as an empty supported-model list.

The extension has no dependency on discovery, does not check model support, and does not expose `supported` or `active`. Its public session interface reads, saves, and publishes the enabled choice. Pi owns the current model. Client changes go through the daemon and session broker to this interface inside Pi; the daemon does not create a separate session-state instance. Other extensions use the same interface rather than saving fast-mode state themselves.

## Considered Options

- Keep discovery in the Pi extension. Rejected: settings and drafts need it before a session exists, and session state does not need it.
- Have the extension consume the host's support list. Rejected: the extension records the requested mode and changes requests; it does not guarantee that a provider will accept or use fast mode.

## Consequences

The UI and validation code use host discovery results independently of the session's enabled choice. An enabled choice is not proof that fast mode is supported or active. This decision replaces the earlier combined interface proposal; runtime changes and final discovery interface types remain to be implemented.
