import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfilesRequest, AgentStartPurpose, SubagentProfileRequest } from "../../../pi-extensions/piop-define-agents/contracts.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeSessionFile, reserveSessionId } from "../piop-storage/session-file.ts";
import { currentHost } from "./client.ts";
import { childFastModeEntry } from "./fast-mode.ts";

export async function resolveAgentProfile(pi: ExtensionAPI, purpose: AgentStartPurpose, agent?: string) {
  const profile: SubagentProfileRequest = { agent, purpose };
  pi.events.emit("piop:agents:subagent", profile);
  await profile.ready;

  if (profile.error) throw new Error(profile.error);

  if (!profile.state) throw new Error("Agent profiles are unavailable");

  return profile.state;
}

export async function createProfileSession(pi: ExtensionAPI, ctx: ExtensionContext, title: string, agent?: string, cwd = ctx.cwd) {
  const header = ctx.sessionManager.getHeader();

  if (!header) throw new Error("Save this conversation before creating another chat");
  const state = await resolveAgentProfile(pi, "peer", agent);
  const fastMode = await childFastModeEntry(pi, state, Boolean(agent));
  const sessionId = await reserveSessionId();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const stateId = randomUUID();
  await writeSessionFile(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd },
    { type: "custom", id: stateId, parentId: null, timestamp, customType: "pi-define-agents-state", data: { ...state, locked: true } },
    ...fastMode ? [{ ...fastMode, id: randomUUID(), parentId: stateId, timestamp }] : [],
  ], { name: title, dependencies: { workspace: { path: cwd, kind: "existing" } } });

  return { peerId: sessionId, hostId: currentHost(), sessionPath, agent: state.active };
}

export { SUBAGENT_TOOLS } from "../../../protocol/subagents.ts";
export const PEER_TOOLS = ["create_peer", "branchoff_peer", "message_peer", "stop_peer", "list_peers", "read_peer", "await_peers"];

export type AgentProfilesMode = AgentStartPurpose | "both";

function listed({ purpose, active, profiles }: AgentProfilesRequest) {
  if (!profiles) throw new Error("Agent profiles are unavailable");

  return { purpose, active, profiles };
}

export async function startableProfiles(pi: ExtensionAPI, purpose: AgentStartPurpose) {
  const catalog: AgentProfilesRequest = { purpose };
  pi.events.emit("piop:agents:profiles", catalog);
  await catalog.ready;

  return listed(catalog);
}

export function lastReadProfiles(pi: ExtensionAPI, purpose: AgentStartPurpose) {
  const catalog: AgentProfilesRequest = { purpose, lastRead: true };
  pi.events.emit("piop:agents:profiles", catalog);

  return listed(catalog);
}

export async function soleProfile(pi: ExtensionAPI, purpose: AgentStartPurpose) {
  const catalog = await startableProfiles(pi, purpose);
  const only = catalog.profiles.length === 1 ? catalog.profiles[0].name : undefined;

  return only === catalog.active ? undefined : only;
}

function profilesTool(pi: ExtensionAPI, mode: AgentProfilesMode) {
  const list = async (purpose: AgentStartPurpose) => {
    const catalog = await startableProfiles(pi, purpose);
    const text = catalog.profiles.length ? JSON.stringify(catalog.profiles) : `You cannot start any agent as a ${purpose}.`;

    return { content: [{ type: "text" as const, text }], details: catalog };
  };

  if (mode === "both") return {
    name: "list_agent_profiles", label: "List agent profiles", exposure: "model-only" as const,
    description: `List the agents you can start: for "subagent" with spawn_subagents, for "peer" with create_peer.`,
    parameters: Type.Object({ for: Type.Union([Type.Literal("subagent"), Type.Literal("peer")]) }),
    execute: (_id: string, params: { for: "subagent" | "peer" }) => list(params.for),
  };

  return {
    name: "list_agent_profiles", label: "List agent profiles", exposure: "model-only" as const,
    description: `List the agents you can start with ${mode === "subagent" ? "spawn_subagents" : "create_peer"}.`,
    parameters: Type.Object({}),
    execute: () => list(mode),
  };
}

export function agentProfilesTool(pi: ExtensionAPI) {
  let registered: AgentProfilesMode = "both";
  pi.registerTool(profilesTool(pi, registered));

  return (subagents: boolean, peers: boolean) => {
    const mode: AgentProfilesMode | undefined = subagents && peers ? "both" : subagents ? "subagent" : peers ? "peer" : undefined;

    if (mode && mode !== registered) { pi.registerTool(profilesTool(pi, mode)); registered = mode; }

    return mode !== undefined;
  };
}
