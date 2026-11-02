import { z } from "zod";
import { agentProfileSchema } from "./agentSchemas";
import type { AgentProfile } from "../types";

// The same rules as the daemon applies when it saves agents, so that an import cannot make settings that do not save.
const MAX_DESCRIPTION = 500;
const EFFORTS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const nonblank = z.string().refine(value => Boolean(value.trim()), "Must not be empty");

const transferAgentSchema = agentProfileSchema.omit({ unavailableReason: true, project: true, isDefault: true }).extend({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Use letters, digits, underscores or hyphens for agent names"),
  description: z.string().refine(value => value.trim().length <= MAX_DESCRIPTION, `Use at most ${MAX_DESCRIPTION} characters`).optional(),
  effort: z.enum(EFFORTS),
  extensions: z.array(nonblank).optional(),
  path_systemprompt: nonblank,
}).strict();

const transferSchema = z.object({ agents: z.array(transferAgentSchema).min(1) }).strict();

const MAX_DEPTH = 32;

type Visit = { value: unknown; key?: string; parent?: Visit; depth: number };

const pathOf = (visit: Visit) => {
  const path: string[] = [];

  for (let at: Visit | undefined = visit; at?.key !== undefined; at = at.parent) path.unshift(at.key);

  return path.length ? `${path.join(".")}: ` : "";
};

// JSON can hold a "__proto__" key, but JavaScript objects drop it silently. Deep nesting breaks later copies of the settings.
function shapeError(value: unknown) {
  const pending: Visit[] = [{ value, depth: 0 }];

  for (let visit = pending.pop(); visit; visit = pending.pop()) {
    if (!visit.value || typeof visit.value !== "object") continue;

    if (visit.depth >= MAX_DEPTH) return `${pathOf(visit)}Nested more than ${MAX_DEPTH} levels`;

    for (const [key, child] of Object.entries(visit.value)) {
      if (key === "__proto__") return `${pathOf(visit)}“__proto__” cannot be used as a name`;
      pending.push({ value: child, key, parent: visit, depth: visit.depth + 1 });
    }
  }
}

export function exportAgents(agents: AgentProfile[]) {
  return JSON.stringify({ agents: agents.map(({ unavailableReason: _reason, project: _project, isDefault: _default, ...agent }) => agent) }, null, 2);
}

/** Parses exported JSON. Throws an Error that tells the user what is wrong. */
export function parseAgentsImport(text: string): AgentProfile[] {
  let value: unknown;

  try { value = JSON.parse(text); } catch (reason) { throw new Error(`Not valid JSON: ${reason instanceof Error ? reason.message : String(reason)}`); }
  const shape = shapeError(value);

  if (shape) throw new Error(shape);
  const parsed = transferSchema.safeParse(value);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  }

  const names = parsed.data.agents.map(agent => agent.name.toLowerCase());
  const repeated = names.find((name, index) => names.indexOf(name) !== index);

  if (repeated) throw new Error(`Agent name “${repeated}” is used more than once`);

  return parsed.data.agents;
}

/** Replaces agents with the same name (case-insensitive) and keeps their name and default flag; adds the others. */
export function mergeImportedAgents(current: AgentProfile[], imported: AgentProfile[]) {
  const next = [...current];
  const changed: number[] = [];

  for (const agent of imported) {
    const index = next.findIndex(item => item.name.toLowerCase() === agent.name.toLowerCase());

    if (index < 0) { changed.push(next.length); next.push(agent); continue; }
    next[index] = { ...agent, name: next[index].name, ...next[index].isDefault ? { isDefault: true } : {} };
    changed.push(index);
  }

  return { agents: next, changed };
}
