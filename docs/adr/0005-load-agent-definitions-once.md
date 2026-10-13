---
status: accepted
---

# Load agent definitions once at agent start

Load the selected agent definition into Pi once, when the agent starts, and keep that definition fixed for the session. Later edits to agent definitions apply to new agents only; settings updates must not reload or replace the definition of an existing agent. This keeps a running agent's setup stable and removes the need to apply definition changes during a session.

When an existing session resumes, restore its saved definition rather than loading the latest edited definition. Extensions remain free to change their own state and tools during the session.

This decision supersedes ADR 0004 only where it says agent-definition edits update existing sessions. Live changes to general or model context-limit settings remain separate from the fixed agent definition.

This records the decision; implementation remains.
