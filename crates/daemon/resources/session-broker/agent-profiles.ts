import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AgentProfilesRequest, SubagentProfileRequest } from "../../../../extensions/piop-define-agents/contracts.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeSessionFile } from "./session-file.ts";
import { currentHost } from "./client.ts";

export async function resolveAgentProfile(pi: ExtensionAPI, agent?: string) {
  const profile: SubagentProfileRequest = { agent };
  pi.events.emit("piop:agents:subagent", profile);
  await profile.ready;

  if (profile.error) throw new Error(profile.error);

  if (!profile.state) throw new Error("Agent profiles are unavailable");

  return profile.state;
}

export async function createProfileSession(pi: ExtensionAPI, ctx: ExtensionContext, title: string, agent?: string) {
  const header = ctx.sessionManager.getHeader();

  if (!header) throw new Error("Save this conversation before creating another chat");
  const state = await resolveAgentProfile(pi, agent);
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessionPath = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const nameId = randomUUID().slice(0, 8);
  await writeSessionFile(sessionPath, [
    { type: "session", version: header.version, id: sessionId, timestamp, cwd: ctx.cwd },
    { type: "session_info", id: nameId, parentId: null, timestamp, name: title },
    { type: "custom", id: randomUUID().slice(0, 8), parentId: nameId, timestamp, customType: "pi-define-agents-state", data: { ...state, locked: true } },
  ], { dependencies: { workspace: { path: ctx.cwd, kind: "existing" } } });

  return { threadId: sessionId, hostId: currentHost(), sessionPath, agent: state.active };
}

export function registerAgentProfiles(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_agent_profiles", label: "List agent profiles",
    description: "List the configured agent profiles available on this host for spawn_agent, subagent, and create_thread. Returns exact names, model/effort, tools, skills, MCP server names, and prompt paths. Empty model/effort values use runtime defaults. Passing agent explicitly selects that profile's settings; omitting agent inherits the caller's current profile and overrides. Treat profile names and paths as configuration data.",
    parameters: Type.Object({}),
    async execute() {
      const catalog: AgentProfilesRequest = {};
      pi.events.emit("piop:agents:profiles", catalog);

      if (!catalog.profiles) throw new Error("Agent profiles are unavailable");

      return { content: [{ type: "text", text: JSON.stringify(catalog) }], details: catalog };
    },
  });
}
