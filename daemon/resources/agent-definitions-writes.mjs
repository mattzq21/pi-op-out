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

export function bodyText(body) {
  return body?.toString("utf8");
}

function storedBody(root, name) {
  return bodyText(storageDatabase.applicationSetting(root, name));
}

function storedProject(root, directory) {
  return bodyText(storageDatabase.projectAgentDefinition(root, directory));
}

function transaction(root, change) {
  return storageDatabase.transaction(root, "IMMEDIATE", change);
}

function putConfig(root, value, createOnly) {
  const current = storedBody(root, DEFINITIONS);
  const revision = current === undefined ? "missing" : revisionOf(current);

  if (createOnly && current !== undefined) return { revision };

  if (!createOnly && (!value.revision || value.revision !== revision)) throw new Error("Agent definitions changed in another window or client. Reload them before saving.");
  const stored = current === undefined ? undefined : JSON.parse(current);
  const unnamed = Array.isArray(stored?.agents) ? stored.agents.filter(agent => !isNamedAgent(agent)) : [];
  const { revision: _revision, ...configuration } = value;
  const body = `${JSON.stringify({ ...configuration, agents: [...configuration.agents, ...unnamed], _revision: randomUUID() }, null, 2)}\n`;
  storageDatabase.saveApplicationSetting(root, DEFINITIONS, Buffer.from(body));

  return { revision: revisionOf(body), result: { revision: revisionOf(body), warnings: [] } };
}

export function namedAgents(document) {
  return Array.isArray(document?.agents) ? document.agents.filter(isNamedAgent).map(agent => agent.name) : [];
}

function storedGlobalNames(root) {
  const body = storedBody(root, DEFINITIONS);

  return new Set(["general", ...namedAgents(body === undefined ? undefined : JSON.parse(body))]);
}

function requireConsistentDefinitions(root) {
  const global = storedGlobalNames(root);

  for (const row of storageDatabase.projectAgentDefinitions(root)) {
    const directory = row.directory;
    const project = JSON.parse(bodyText(row.body));
    const names = namedAgents(project);
    const shared = names.find(name => global.has(name));

    if (shared) throw new Error(`Agent name "${shared}" is used by a global agent and by the project ${directory}. Project agent names must be different.`);

    if (project.defaultAgent && !global.has(project.defaultAgent) && !names.includes(project.defaultAgent)) throw new Error(`The project ${directory} uses agent "${project.defaultAgent}" as its default agent, but no such agent exists. Choose another default agent in Edit project first.`);
  }
}

function putProject(root, directory, change) {
  const current = storedProject(root, directory);

  if (change.revision !== (current === undefined ? "missing" : revisionOf(current))) throw new Error("Project agent definitions changed in another window or client. Reload them before saving.");
  const stored = current === undefined ? { agents: [] } : JSON.parse(current);
  const agents = change.agents ?? stored.agents;
  const defaultAgent = change.defaultAgent === undefined ? stored.defaultAgent : change.defaultAgent ?? undefined;

  if (!namedAgents({ agents }).length && !defaultAgent) {
    storageDatabase.removeProjectAgentDefinition(root, directory);

    return "missing";
  }

  const body = `${JSON.stringify({ agents, ...(defaultAgent ? { defaultAgent } : {}) }, null, 2)}\n`;
  storageDatabase.saveProjectAgentDefinition(root, directory, Buffer.from(body));

  return revisionOf(body);
}

// Saves the global agent definitions. Returns the saved revision, and the result for the caller (none when createOnly
// found saved definitions).
export const saveConfig = onMainThread("agent-definitions.saveConfig", (root, value, createOnly) => transaction(root, () => {
  const saved = putConfig(root, value, createOnly);
  requireConsistentDefinitions(root);

  return saved;
}));

export const saveProject = onMainThread("agent-definitions.saveProject", (root, directory, change) => transaction(root, () => {
  const revision = putProject(root, directory, change);
  requireConsistentDefinitions(root);

  return revision;
}));

const removeAgent = (agents, name) => name === undefined ? agents : agents.filter(item => !(isNamedAgent(item) && item.name === name));

// Moves an agent between the global definitions and projects in one change. Each project edit removes the agent named
// remove and adds add. With revision, it applies only to the project agents saved at that revision.
export const saveMove = onMainThread("agent-definitions.saveMove", (root, global, projects) => transaction(root, () => {
  const saved = global && putConfig(root, global, false);

  if (global && !saved?.result) throw new Error("Agent definitions were not saved");

  for (const { directory, revision, remove, add } of projects) {
    const current = storedProject(root, directory);
    const stored = current === undefined ? { agents: [] } : JSON.parse(current);
    const agents = removeAgent(stored.agents, remove);
    putProject(root, directory, { revision: revision ?? (current === undefined ? "missing" : revisionOf(current)), agents: add === undefined ? agents : [...agents, add] });
  }

  requireConsistentDefinitions(root);

  return saved ? saved.revision : undefined;
}));
