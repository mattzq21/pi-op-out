import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AgentProfilesRequest, AgentStartPurpose, SubagentProfileRequest } from "../../../extensions/piop-define-agents/contracts.ts";
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

/** cwd: the new chat's folder, the caller's by default. */
export async function createProfileSession(pi: ExtensionAPI, ctx: ExtensionContext, title: string, agent?: string, cwd = ctx.cwd) {
  const header = ctx.sessionManager.getHeader();

  if (!header) throw new Error("Save this conversation before creating another chat");
  const state = await resolveAgentProfile(pi, "peer", agent);
  const fastMode = await childFastModeEntry(pi, state, Boolean(agent));
  const sessionId = await reserveSessionId();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const nameId = randomUUID();
  const stateId = randomUUID();
  await writeSessionFile(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd },
    { type: "session_info", id: nameId, parentId: null, timestamp, name: title },
    { type: "custom", id: stateId, parentId: nameId, timestamp, customType: "pi-define-agents-state", data: { ...state, locked: true } },
    ...fastMode ? [{ ...fastMode, id: randomUUID(), parentId: stateId, timestamp }] : [],
  ], { dependencies: { workspace: { path: cwd, kind: "existing" } } });

  return { peerId: sessionId, hostId: currentHost(), sessionPath, agent: state.active };
}

/** The tools that make a tool group on for an agent. One tool of a group is enough. */
export const SUBAGENT_TOOLS = ["spawn_subagents", "message_subagent", "stop_subagent", "list_subagents", "await_subagents"];
export const PEER_TOOLS = ["create_peer", "branchoff_peer", "message_peer", "stop_peer", "list_peers", "read_peer", "await_peers"];

/** Which agents list_agent_profiles lists: for one start purpose, or for both, chosen by an argument. */
export type AgentProfilesMode = AgentStartPurpose | "both";

function profilesTool(pi: ExtensionAPI, mode: AgentProfilesMode) {
  const list = async (purpose: AgentStartPurpose) => {
    const catalog: AgentProfilesRequest = { purpose };
    pi.events.emit("piop:agents:profiles", catalog);

    if (!catalog.profiles) throw new Error("Agent profiles are unavailable");
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

/** Keeps list_agent_profiles in the shape for the agent's tool groups, and returns whether the agent has it. */
export function agentProfilesTool(pi: ExtensionAPI) {
  // Registered at load, so the tool exists before an agent's tools are checked.
  let registered: AgentProfilesMode = "both";
  pi.registerTool(profilesTool(pi, registered));

  return (subagents: boolean, peers: boolean) => {
    const mode: AgentProfilesMode | undefined = subagents && peers ? "both" : subagents ? "subagent" : peers ? "peer" : undefined;

    if (mode && mode !== registered) { pi.registerTool(profilesTool(pi, mode)); registered = mode; }

    return mode !== undefined;
  };
}
