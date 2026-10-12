import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Agent, SessionAgentState } from "./contracts.ts";
import { nativeMcpSchema, legacyMcpSchema, mcpServers } from "./mcp-config.ts";

export const STATE_ENTRY = "pi-define-agents-state";

export const DEFAULTS_ENV = "PI_DEFINE_AGENTS_RUNTIME_DEFAULTS";

export const DRAFT_STATE_ENV = "PIOP_AGENT_DRAFT_STATE";

export type RuntimeDefaults = { model: string; effort: string };

export const agentThinkingLevels: Array<Parameters<ExtensionAPI["setThinkingLevel"]>[0]> = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const agentSchema = Type.Object({
  max_subagents: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), max_sub_subagents: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  name: Type.String(), model: Type.String(), effort: Type.String(), fastMode: Type.Optional(Type.Boolean()), codemode: Type.Optional(Type.Boolean()), extensions: Type.Optional(Type.Array(Type.String())),
  path_systemprompt: Type.String(), path_agent_prompt: Type.String(), tools: Type.Array(Type.String()), skills: Type.Array(Type.String()), mcpServers: nativeMcpSchema,
});

export function subagentLimit(value: number | undefined, name: string, field: string) {
  if (value === undefined) return 8;

  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Agent "${name}" ${field} must be a nonnegative integer`);

  return value;
}

export function registerSubagentLimits(pi: ExtensionAPI, currentAgent: () => Agent | undefined) {
  const stop = pi.events.on("piop:agents:subagent-limits", request => {
    request.max_subagents = currentAgent()?.max_subagents ?? 8;
    request.max_sub_subagents = currentAgent()?.max_sub_subagents ?? 8;
  });

  pi.on("session_shutdown", stop);
}

const storedAgentSchema = Type.Object({
  ...Type.Omit(agentSchema, ["path_agent_prompt"]).properties,
  path_agent_prompt: Type.Optional(Type.String()), path_agentprompt: Type.Optional(Type.String()),
  mcpServers: Type.Union([nativeMcpSchema, legacyMcpSchema]),
});

const snapshotSchema = Type.Union([
  Type.Object({ version: Type.Literal(2), definition: storedAgentSchema }),
  Type.Object({ version: Type.Literal(1), definition: storedAgentSchema, systemPrompt: Type.String(), agentPrompt: Type.String() }),
]);

const stateSchema = Type.Object({
  snapshot: Type.Optional(snapshotSchema), active: Type.Optional(Type.String()), locked: Type.Optional(Type.Boolean()),
  modelOverride: Type.Optional(Type.String()), effortOverride: Type.Optional(Type.String()),
});

const draftSchema = Type.Object({ session: Type.String(), identity: Type.Optional(Type.String()), state: stateSchema });

const defaultsSchema = Type.Object({ session: Type.String(), model: Type.String(), effort: Type.String() });

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

export function persistedAgentIdentity(state: SessionAgentState) {
  const agent = state.snapshot?.definition;

  return JSON.stringify([state.active, state.modelOverride || agent?.model, state.effortOverride || agent?.effort]);
}

function draftAgentState(session: string, identity: string | undefined) {
  try {
    const draft = JSON.parse(process.env[DRAFT_STATE_ENV] || "null");

    return Check(draftSchema, draft) && draft.session === session && draft.identity === identity ? draft.state : undefined;
  } catch { return undefined; }
}

export function storedRuntimeDefaults(session: string): RuntimeDefaults | undefined {
  try {
    const stored = JSON.parse(process.env[DEFAULTS_ENV] || "null");

    if (Check(defaultsSchema, stored) && stored.session === session) return { model: stored.model, effort: stored.effort };
  } catch { }
}

export function sessionIsLocked(states: SessionAgentState[], branch: Branch) {
  return states.some(state => state.locked === true) || branch.some(entry => entry.type === "compaction" || (entry.type === "message" && ["user", "assistant"].includes(entry.message.role)));
}

export function readAgentState(branch: Branch, session: string) {
  const states = branch.flatMap(entry => entry.type === "custom" && entry.customType === STATE_ENTRY && Check(stateSchema, entry.data) ? [normalizeState(entry.data)] : []);
  const persisted = states.at(-1);
  const identity = persisted ? persistedAgentIdentity(persisted) : undefined;
  const draft = draftAgentState(session, identity);
  const stored = draft ? normalizeState(draft) : persisted;

  return { states, stored, identity };
}

function normalizeState(state: Static<typeof stateSchema>): SessionAgentState {
  const snapshot = state.snapshot;

  if (!snapshot) return { ...state, snapshot: undefined };
  const { path_agentprompt, ...definition } = snapshot.definition;

  return { ...state, snapshot: { ...snapshot, definition: { ...definition, path_agent_prompt: definition.path_agent_prompt ?? path_agentprompt ?? "", mcpServers: mcpServers(definition.mcpServers) } } };
}
