---
status: accepted
---

# The daemon owns the agent definitions in the settings database

Saving agent definitions started a Pi session only to send one command to the `piop-define-agents` extension, which made each save take seconds. The settings page also started Pi to read the definitions, models and thinking levels.

The daemon owns the agent definitions. They are one JSON document, `agent-definitions.json`, in the `application_settings` table of the settings database (`~/.piop/sessions.sqlite`). Agent prompt snapshots are in the same database. The daemon reads, checks and writes them in the `agents` worker queue: `save_agent_definitions {hostId, configuration}` checks the definitions as a new agent would start, saves them in one SQLite transaction when their revision is still the saved one, applies them to new agents and sends `agent-definitions-changed {hostId}`. Remote hosts receive the save through the link between daemons.

Agent definitions stay core, not a plugin: chats, subagent profiles, the default agent and Settings → Agents depend on them.

The `piop-define-agents` extension only applies an agent in a chat. It reads the definitions when a chat starts, when the user chooses an agent and when the host tells it that they changed, and never writes them. Its status reports only the chat's own agent; clients take the list of agents from the host catalog (`draft_catalog`), which the settings page also uses for agents and models.

Agent definitions and app settings save separately; each save is complete on its own.

## Consequences

- The settings page and an agent save never start Pi.
- Definitions that a new agent could not start from cannot be saved.
- The extension commands `configure_agents` and `get_agent_configuration` and the agent revision in app settings are removed.
- The daemon moves definitions and prompt snapshots from the old database in `piop-define-agents/` once, then removes it.
