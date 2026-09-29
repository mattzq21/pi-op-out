import { encodeAgentValue } from "./lib/agentProtocol";
import { createMemo, type Accessor } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { AgentState, AppSettings, DefinedAgentsCapability, Model } from "./types";

export type ProjectControls = { agent?: string; model: Model | null; thinking: string; fastMode?: boolean; contextWindow?: number };

export async function openDraftSession(owner: NativeTransport, target: { cwd?: string; hostId?: string }, current: () => NativeTransport, select: () => void, onError: (reason: unknown) => void) {
  try {
    if (target.cwd) await owner.validateProjectDirectory(target.cwd, target.hostId ?? "local", true);
    if (current() === owner) select();
  } catch (reason) { if (current() === owner) onError(reason); }
}

function initialContextUsage(state: AgentState, inherited?: ProjectControls) {
  if (state.messageCount > 0 || state.isStreaming || state.pendingMessageCount > 0) return state.contextUsage ?? pendingContextUsage(state, inherited);
  if (!inherited && state.contextUsage) return state.contextUsage;
  return emptyContextUsage(state, inherited);
}

function pendingContextUsage(state: AgentState, inherited?: ProjectControls) {
  const usage = emptyContextUsage(state, inherited);
  return usage && { ...usage, tokens: null, percent: null };
}

function emptyContextUsage(state: AgentState, inherited?: ProjectControls) {
  const contextWindow = inherited?.contextWindow ?? inherited?.model?.contextWindow ?? state.model?.contextWindow;
  return contextWindow && contextWindow > 0 ? { tokens: 0, percent: 0, contextWindow } : state.contextUsage;
}

export function createComposerControls(transport: Accessor<NativeTransport>, connected: Accessor<boolean>, controls: WeakMap<NativeTransport, ProjectControls>) {
  const snapshot = createMemo<{ owner: NativeTransport; controls?: ProjectControls }>((previous) => {
    const owner = transport();
    const inherited = previous?.owner === owner ? previous.controls : controls.get(owner);
    return { owner, controls: connected() ? undefined : inherited };
  });
  return {
    state: (state: AgentState) => {
      const inherited = snapshot().controls;
      const contextUsage = initialContextUsage(state, inherited);
      return inherited ? { ...state, model: inherited.model, thinkingLevel: inherited.thinking, contextUsage } : { ...state, contextUsage };
    },
    statuses: (statuses: Record<string, string>) => {
      const inherited = snapshot().controls;
      return inherited?.fastMode === undefined ? statuses : { ...statuses, "pi-desktop-fast-mode": inherited.fastMode ? "Fast mode on" : "Fast mode off" };
    },
    thinkingLevels: (levels: string[]) => {
      const thinking = snapshot().controls?.thinking;
      return thinking && !levels.includes(thinking) ? [...levels, thinking] : levels;
    },
    agent: (agent?: string) => snapshot().controls?.agent ?? agent,
  };
}

export function newChatAgent(agents: DefinedAgentsCapability | undefined, defaultAgent?: string) {
  const available = agents?.config.agents ?? [];
  return [agents?.active, defaultAgent, "general"].find((name) => available.some((agent) => agent.name === name)) ?? available[0]?.name;
}

export function inheritGroupControls(controls: WeakMap<NativeTransport, ProjectControls>, target: NativeTransport, grouped: boolean, state: AgentState, agents: DefinedAgentsCapability | undefined, statuses: Record<string, string>, settings?: AppSettings) {
  if (grouped) controls.set(target, { agent: newChatAgent(agents, settings?.defaultAgent), model: state.model, thinking: state.thinkingLevel, fastMode: statuses["pi-desktop-fast-mode"] === "Fast mode on", contextWindow: state.contextUsage?.contextWindow ?? state.model?.contextWindow });
}

export function reassignTerminals(transport: NativeTransport, terminals: readonly { id: string; started: boolean }[], sessionKey: string, onError: (reason: unknown) => void) {
  for (const terminal of terminals) {
    if (terminal.started) void transport.reassignTerminal(terminal.id, sessionKey).catch(onError);
  }
}

async function applyInherited(transport: NativeTransport, inherited: ProjectControls, models: Model[]) {
  if (inherited.agent) await transport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(inherited.agent)}` });
  if (inherited.model && models.some((model) => model.provider === inherited.model!.provider && model.id === inherited.model!.id)) {
    await transport.command({ type: "set_model", provider: inherited.model.provider, modelId: inherited.model.id });
  }
  const { levels } = await transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" });
  if (levels.includes(inherited.thinking)) await transport.command({ type: "set_thinking_level", level: inherited.thinking });
  if (inherited.fastMode !== undefined) await transport.setFastMode(inherited.fastMode);
}

async function applyDefaults(transport: NativeTransport, value: AppSettings, models: Model[], current: () => boolean) {
  const model = models.find((model) => `${model.provider}/${model.id}` === value.defaultModel);
  if (model) await transport.command({ type: "set_model", provider: model.provider, modelId: model.id });
  if (!current()) return;
  const { levels } = await transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" });
  if (!current()) return;
  if (levels.includes(value.defaultThinking)) await transport.command({ type: "set_thinking_level", level: value.defaultThinking });
  if (!current()) return;
  await transport.setFastMode(value.defaultFastMode);
  if (!current()) return;
  await transport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(value.defaultAgent ?? "general")}` });
  transport.defaultsApplied();
}

export async function configureConversationRuntime(value: AppSettings, transport: NativeTransport, activeTransport: () => NativeTransport, projectControls: WeakMap<NativeTransport, ProjectControls>) {
  const current = () => activeTransport() === transport;
  if (!current() || !transport.ownsConversation()) return;
  if (transport.currentHostId() !== "local") value = await transport.loadHostSettings();
  if (!current()) return;
  const [modelResult] = await Promise.allSettled([
    transport.command<{ models: Model[] }>({ type: "get_available_models" }),
    transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" }),
  ]);
  if (!current()) return;
  await Promise.all([
    transport.command({ type: "set_auto_compaction", enabled: true }),
    transport.command({ type: "set_auto_retry", enabled: value.autoRetry }),
  ]);
  if (!current()) return;
  const availableModels = modelResult.status === "fulfilled" ? modelResult.value.models : [];
  const inherited = projectControls.get(transport);
  if (inherited) {
    await applyInherited(transport, inherited, availableModels);
    projectControls.delete(transport); transport.defaultsApplied();
    return;
  }
  if (transport.needsDefaults()) await applyDefaults(transport, value, availableModels, current);
}
