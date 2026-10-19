import { agentStateSchema } from "./lib/responseSchemas";
import type { Accessor } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { AgentState, AppSettings } from "./types";

export async function openDraftSession(owner: NativeTransport, target: { cwd?: string; hostId?: string }, current: () => NativeTransport, select: () => void, onError: (cause: unknown) => void) {
  try {
    if (target.cwd) await owner.validateProjectDirectory(target.cwd, target.hostId ?? "local", true);

    if (current() === owner) select();
  } catch (reason) { if (current() === owner) onError(reason); }
}

function contextUsage(state: AgentState) {
  if (state.messageCount > 0 || state.isStreaming || state.pendingMessageCount > 0 || state.contextUsage) return state.contextUsage;
  const contextWindow = state.model?.contextWindow;

  return contextWindow && contextWindow > 0 ? { tokens: 0, percent: 0, contextWindow } : state.contextUsage;
}

export function createComposerControls(transport: Accessor<NativeTransport>, fastModels: Accessor<string[] | undefined> = () => undefined) {
  return {
    state: (state: AgentState) => transport().promptControls.state({ ...state, contextUsage: contextUsage(state) }),
    statuses: (statuses: Record<string, string>, model: AgentState["model"] | undefined) => transport().promptControls.statuses(statuses, fastModels(), model),
    thinkingLevels: (levels: string[]) => transport().promptControls.levels(levels),
  };
}

export function reassignTerminals(transport: NativeTransport, terminals: readonly { id: string; started: boolean }[], sessionKey: string, onError: (cause: unknown) => void) {
  for (const terminal of terminals) {
    if (terminal.started) void transport.reassignTerminal(terminal.id, sessionKey).catch(onError);
  }
}

export async function configureConversationRuntime(value: AppSettings, transport: NativeTransport, activeTransport: () => NativeTransport) {
  const current = () => activeTransport() === transport;

  if (!current() || !transport.ownsConversation()) return;

  if (transport.currentHostId() !== "local") value = await transport.loadHostSettings();

  if (!current()) return;
  transport.setDefaultFastMode(value.defaultFastMode);

  await transport.configureAutomaticBehavior(value.autoRetry);

  if (!current() || !transport.needsDefaults()) return;
  await transport.applyNewChatDefaults(value.defaultThinking, value.defaultFastMode);

  if (!current()) return;
  const state = await transport.command({ type: "get_state" }, agentStateSchema);

  if (!current()) return;

  if (state.model) transport.promptControls.useEffectiveModel(state.model);
  else transport.promptControls.clearModel();
  transport.defaultsApplied();
}
