import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionAgentState } from "./contracts.ts";
import { nativeMcpSchema, legacyMcpSchema, mcpServers } from "./mcp-config.ts";

export const STATE_ENTRY = "pi-define-agents-state";

export const DEFAULTS_ENV = "PI_DEFINE_AGENTS_RUNTIME_DEFAULTS";

export const DRAFT_STATE_ENV = "PIOP_AGENT_DRAFT_STATE";

export type RuntimeDefaults = { model: string; effort: string };

export const agentSchema = Type.Object({
  name: Type.String(), model: Type.String(), effort: Type.String(), fastMode: Type.Optional(Type.Boolean()), extensions: Type.Optional(Type.Array(Type.String())),
  path_systemprompt: Type.String(), path_agentprompt: Type.String(), tools: Type.Array(Type.String()), skills: Type.Array(Type.String()), mcpServers: nativeMcpSchema,
});

const storedAgentSchema = Type.Object({ ...agentSchema.properties, mcpServers: Type.Union([nativeMcpSchema, legacyMcpSchema]) });

const snapshotSchema = Type.Union([
  Type.Object({ version: Type.Literal(2), definition: storedAgentSchema }),
  Type.Object({ version: Type.Literal(1), definition: storedAgentSchema, systemPrompt: Type.String(), agentPrompt: Type.String() }),
]);

const stateSchema = Type.Object({
  snapshot: Type.Optional(snapshotSchema), active: Type.Optional(Type.String()), locked: Type.Optional(Type.Boolean()),
  modelOverride: Type.Optional(Type.String()), effortOverride: Type.Optional(Type.String()), fastModeOverride: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});

const draftSchema = Type.Object({ session: Type.String(), identity: Type.Optional(Type.String()), state: stateSchema });

const defaultsSchema = Type.Object({ session: Type.String(), model: Type.String(), effort: Type.String() });

const fastModeSchema = Type.Object({ fastModeOverride: Type.Union([Type.Boolean(), Type.Null()]) });

const legacyFastModeSchema = Type.Object({ enabled: Type.Optional(Type.Boolean()), manual: Type.Optional(Type.Boolean()) });

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

export function persistedAgentIdentity(state: SessionAgentState) {
  const agent = state.snapshot?.definition;

  return JSON.stringify([state.active, state.modelOverride || agent?.model, state.effortOverride || agent?.effort, state.fastModeOverride ?? agent?.fastMode ?? false]);
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

function restoredFastMode(branch: Branch) {
  for (const entry of [...branch].reverse()) {
    if (entry.type !== "custom") continue;

    if (entry.customType === STATE_ENTRY && Check(fastModeSchema, entry.data)) return entry.data.fastModeOverride ?? undefined;

    if (entry.customType === "piop-fast-mode-state" && Check(legacyFastModeSchema, entry.data)) return entry.data.manual === false ? undefined : entry.data.enabled;
  }
}

export function readAgentState(branch: Branch, session: string) {
  const states = branch.flatMap(entry => entry.type === "custom" && entry.customType === STATE_ENTRY && Check(stateSchema, entry.data) ? [normalizeState(entry.data)] : []);
  const persisted = states.at(-1);
  const identity = persisted ? persistedAgentIdentity(persisted) : undefined;
  const draft = draftAgentState(session, identity);
  const stored = draft ? normalizeState(draft) : persisted;

  return { states, stored, identity, fastMode: stored?.fastModeOverride ?? restoredFastMode(branch) };
}

function normalizeState(state: Static<typeof stateSchema>): SessionAgentState {
  const snapshot = state.snapshot;

  return { ...state, snapshot: snapshot && { ...snapshot, definition: { ...snapshot.definition, mcpServers: mcpServers(snapshot.definition.mcpServers) } } };
}
