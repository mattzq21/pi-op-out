---
status: accepted
---

# Separate session execution and storage from Piop

Each session has its own Pi runtime: Pi and the extensions loaded for that session. The runtime owns session execution and session content. Piop manages the sessions through defined interfaces. This keeps session rules in one place and prevents Piop and extensions from maintaining separate copies of the same state.

One storage extension owns persistence for Pi and its extensions. It stores messages, tool results, and conversation history in the transcript. It stores session control state in SQL, including goals, pause state, agent settings, limits, subagent runs, usage accounting, review relationships, and provider cache identity. Visible summaries and results can remain messages; they are not the saved control state. State that follows a branch must retain its branch association. Forking must explicitly copy the required state and assign new IDs where needed.

The Piop daemon owns session IDs, registered locations, discovery, archive, restore, and deletion. Runtime storage uses the identities and locations supplied by the daemon. Each session owns its state logically; this does not require a separate SQL database for each session.

Before moving or deleting session storage, the daemon stops its runtime and prevents another writer from starting until the operation finishes. The daemon coordinates the operation; storage-owned code handles session content, related SQL state, attachments, and cleanup. That code must also work while the runtime is stopped. Archive and restore preserve session state. Deletion removes owned state and releases shared data only when no remaining session needs it.

Storage changes must complete or roll back, including after a crash. Use transactions and recoverable operations where SQL and files must change together. Report failures and uncertain outcomes. Publish state changes through events instead of polling when reliable change events are available.

This records the ownership decision, not a claim that all existing code already follows it.
