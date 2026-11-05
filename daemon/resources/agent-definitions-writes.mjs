import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
import * as storageDatabase from "./session-database.cjs";
import { onMainThread } from "./main-thread.cjs";

// The agent definitions in the storage database: the global ones, and those of each project. Only the daemon's main
// thread saves them. The agent loader runs in a worker thread and asks for each change.

export const DEFINITIONS = "agent-definitions";

export const isNamedAgent = agent => Check(Type.Object({ name: Type.String({ pattern: "\\S" }) }), agent);

export function revisionOf(body) { return createHash("sha256").update(body).digest("hex"); }

export function bodyText(row) {
  return row?.body == null ? undefined : Buffer.from(row.body).toString("utf8");
}

export function storedBody(db, name) {
  return bodyText(db.prepare("SELECT body FROM application_settings WHERE name=?").get(name));
}

function transaction(root, change) {
  const db = storageDatabase.connection(root);

  return storageDatabase.transaction(db, "IMMEDIATE", () => change(db));
}

function putConfig(db, value, createOnly) {
  const current = storedBody(db, DEFINITIONS);
  const revision = current === undefined ? "missing" : revisionOf(current);

  if (createOnly && current !== undefined) return { revision };

  if (!createOnly && (!value.revision || value.revision !== revision)) throw new Error("Agent definitions changed in another window or client. Reload them before saving.");
  const stored = current === undefined ? undefined : JSON.parse(current);
  const unnamed = Array.isArray(stored?.agents) ? stored.agents.filter(agent => !isNamedAgent(agent)) : [];
  const { revision: _revision, ...configuration } = value;
  const body = `${JSON.stringify({ ...configuration, agents: [...configuration.agents, ...unnamed], _revision: randomUUID() }, null, 2)}\n`;
  db.prepare("INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body").run(DEFINITIONS, Buffer.from(body));

  return { revision: revisionOf(body), result: { revision: revisionOf(body), warnings: [] } };
}

export function namedAgents(document) {
  return Array.isArray(document?.agents) ? document.agents.filter(isNamedAgent).map(agent => agent.name) : [];
}

function storedGlobalNames(db) {
  const body = storedBody(db, DEFINITIONS);

  return new Set(["general", ...namedAgents(body === undefined ? undefined : JSON.parse(body))]);
}

function requireConsistentDefinitions(db) {
  const global = storedGlobalNames(db);

  for (const row of db.prepare("SELECT directory, body FROM project_agent_definitions").all()) {
    const directory = String(row.directory);
    const project = JSON.parse(String(bodyText(row)));
    const names = namedAgents(project);
    const shared = names.find(name => global.has(name));

    if (shared) throw new Error(`Agent name "${shared}" is used by a global agent and by the project ${directory}. Project agent names must be different.`);

    if (project.defaultAgent && !global.has(project.defaultAgent) && !names.includes(project.defaultAgent)) throw new Error(`The project ${directory} uses agent "${project.defaultAgent}" as its default agent, but no such agent exists. Choose another default agent in Edit project first.`);
  }
}

function putProject(db, directory, change) {
  const current = bodyText(db.prepare("SELECT body FROM project_agent_definitions WHERE directory=?").get(directory));

  if (change.revision !== (current === undefined ? "missing" : revisionOf(current))) throw new Error("Project agent definitions changed in another window or client. Reload them before saving.");
  const stored = current === undefined ? { agents: [] } : JSON.parse(current);
  const agents = change.agents ?? stored.agents;
  const defaultAgent = change.defaultAgent === undefined ? stored.defaultAgent : change.defaultAgent ?? undefined;

  if (!namedAgents({ agents }).length && !defaultAgent) {
    db.prepare("DELETE FROM project_agent_definitions WHERE directory=?").run(directory);

    return "missing";
  }

  const body = `${JSON.stringify({ agents, ...(defaultAgent ? { defaultAgent } : {}) }, null, 2)}\n`;
  db.prepare("INSERT INTO project_agent_definitions (directory, body) VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET body=excluded.body").run(directory, Buffer.from(body));

  return revisionOf(body);
}

// Saves the global agent definitions. Returns the saved revision, and the result for the caller (none when createOnly
// found saved definitions).
export const saveConfig = onMainThread("agent-definitions.saveConfig", (root, value, createOnly) => transaction(root, db => {
  const saved = putConfig(db, value, createOnly);
  requireConsistentDefinitions(db);

  return saved;
}));

export const saveProject = onMainThread("agent-definitions.saveProject", (root, directory, change) => transaction(root, db => {
  const revision = putProject(db, directory, change);
  requireConsistentDefinitions(db);

  return revision;
}));

const removeAgent = (agents, name) => name === undefined ? agents : agents.filter(item => !(isNamedAgent(item) && item.name === name));

// Moves an agent between the global definitions and projects in one change. Each project edit removes the agent named
// remove and adds add. With revision, it applies only to the project agents saved at that revision.
export const saveMove = onMainThread("agent-definitions.saveMove", (root, global, projects) => transaction(root, db => {
  const saved = global && putConfig(db, global, false);

  if (global && !saved?.result) throw new Error("Agent definitions were not saved");

  for (const { directory, revision, remove, add } of projects) {
    const current = bodyText(db.prepare("SELECT body FROM project_agent_definitions WHERE directory=?").get(directory));
    const stored = current === undefined ? { agents: [] } : JSON.parse(current);
    const agents = removeAgent(stored.agents, remove);
    putProject(db, directory, { revision: revision ?? (current === undefined ? "missing" : revisionOf(current)), agents: add === undefined ? agents : [...agents, add] });
  }

  requireConsistentDefinitions(db);

  return saved ? saved.revision : undefined;
}));
