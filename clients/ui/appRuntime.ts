import { z } from "zod";
import { modelSchema } from "./lib/responseSchemas";
import { required } from "./lib/required";
import { createMemo, type Accessor } from "solid-js";
import type { NativeTransport } from "./lib/nativeTransport";
import type { AgentState, AppSettings, DefinedAgentsCapability, Model } from "./types";

export type ProjectControls = { agent?: string; model: Model | null; thinking: string; fastMode?: boolean; contextWindow?: number };

export async function openDraftSession(owner: NativeTransport, target: { cwd?: string; hostId?: string }, current: () => NativeTransport, select: () => void, onError: (cause: unknown) => void) {
  try {
    if (target.cwd) await owner.validateProjectDirectory(target.cwd, target.hostId ?? "local", true);

    if (current() === owner) select();
  } catch (reason) { if (current() === owner) onError(reason); }
}

function initialContextUsage(state: AgentState, inherited?: ProjectControls) {
  if (state.messageCount > 0 || state.isStreaming || state.pendingMessageCount > 0) return state.contextUsage;

  if (!inherited && state.contextUsage) return state.contextUsage;

  return emptyContextUsage(state, inherited);
}

function emptyContextUsage(state: AgentState, inherited?: ProjectControls) {
  const contextWindow = inherited?.contextWindow ?? inherited?.model?.contextWindow ?? state.model?.contextWindow;

  return contextWindow && contextWindow > 0 ? { tokens: 0, percent: 0, contextWindow } : state.contextUsage;
}

export function createComposerControls(transport: Accessor<NativeTransport>, connected: Accessor<boolean>, controls: WeakMap<NativeTransport, ProjectControls>, fastModels: Accessor<string[] | undefined> = () => undefined) {
  const snapshot = createMemo<{ owner: NativeTransport; controls?: ProjectControls }>((previous) => {
    const owner = transport();
    const inherited = previous?.owner === owner ? previous.controls : controls.get(owner);

    return { owner, controls: connected() ? undefined : inherited };
  });

  return {
    state: (state: AgentState) => {
      const inherited = snapshot().controls;
      const contextUsage = initialContextUsage(state, inherited);

      return transport().promptControls.state(inherited ? { ...state, model: inherited.model, thinkingLevel: inherited.thinking, contextUsage } : { ...state, contextUsage });
    },
    statuses: (statuses: Record<string, string>) => {
      const inherited = snapshot().controls;

      return transport().promptControls.statuses(inherited?.fastMode === undefined ? statuses : { ...statuses, "pi-desktop-fast-mode": inherited.fastMode ? "Fast mode on" : "Fast mode off" }, fastModels());
    },
    thinkingLevels: (levels: string[]) => {
      const thinking = snapshot().controls?.thinking;

      return transport().promptControls.levels(thinking && !levels.includes(thinking) ? [...levels, thinking] : levels);
    },
    agent: (agent?: string) => snapshot().controls?.agent ?? agent,
  };
}

export function newChatAgent(agents: DefinedAgentsCapability | undefined, defaultAgent?: string) {
  const available = agents?.config.agents ?? [];

  return [agents?.active, defaultAgent, "general"].find((name) => available.some((agent) => agent.name === name)) ?? available[0]?.name;
}

export function inheritGroupControls(controls: WeakMap<NativeTransport, ProjectControls>, target: NativeTransport, grouped: boolean, state: AgentState, agents: DefinedAgentsCapability | undefined, statuses: Record<string, string>, settings?: AppSettings) {
  if (!grouped) return;
  const agent = newChatAgent(agents, settings?.defaultAgent);
  const thinking = state.thinkingLevel;
  controls.set(target, { agent, model: state.model, thinking, fastMode: statuses["pi-desktop-fast-mode"] === "Fast mode on", contextWindow: state.contextUsage?.contextWindow ?? state.model?.contextWindow });
}

export function reassignTerminals(transport: NativeTransport, terminals: readonly { id: string; started: boolean }[], sessionKey: string, onError: (cause: unknown) => void) {
  for (const terminal of terminals) {
    if (terminal.started) void transport.reassignTerminal(terminal.id, sessionKey).catch(onError);
  }
}

type Notice = (notice: { title: string; message: string }) => void;

const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

async function setStartModel(transport: NativeTransport, wanted: string | undefined, models: Model[], hiddenModels: readonly string[], addNotice: Notice) {
  const model = models.find((model) => modelKey(model) === wanted);

  if (model) { await transport.command({ type: "set_model", provider: model.provider, modelId: model.id }); return; }
  const fallback = models.find((model) => !hiddenModels.includes(modelKey(model)));

  if (!fallback) throw new Error(`Model ${wanted ?? "(none)"} is not available on this machine and no enabled model exists. Enable a model in Settings → Models.`);
  await transport.command({ type: "set_model", provider: fallback.provider, modelId: fallback.id });
  addNotice({ title: "Default model unavailable", message: `${wanted ?? "No default model"} is not available on this machine. Using ${fallback.name || modelKey(fallback)}.` });
}

async function applyInherited(transport: NativeTransport, inherited: ProjectControls, defaultModel: string, models: Model[], hiddenModels: readonly string[], addNotice: Notice) {
  if (inherited.agent) await transport.command({ type: "select_agent", agent: inherited.agent });

  if (inherited.model && models.some((model) => model.provider === required(inherited.model).provider && model.id === required(inherited.model).id)) transport.promptControls.model(inherited.model);
  else await setStartModel(transport, inherited.model ? modelKey(inherited.model) : defaultModel, models, hiddenModels, addNotice);

  transport.promptControls.thinking(inherited.thinking);

  if (inherited.fastMode !== undefined) transport.promptControls.fast(inherited.fastMode);
}

async function applyDefaults(transport: NativeTransport, value: AppSettings, models: Model[], hiddenModels: readonly string[], current: () => boolean, addNotice: Notice) {
  await setStartModel(transport, value.defaultModel, models, hiddenModels, addNotice);

  if (!current()) return;
  await transport.command({ type: "set_thinking_level", level: value.defaultThinking });

  if (!current()) return;
  await transport.setFastMode(value.defaultFastMode);

  if (!current()) return;
  await transport.command({ type: "select_agent", agent: value.defaultAgent ?? "general" });
  transport.defaultsApplied();
}

export async function configureConversationRuntime(value: AppSettings, transport: NativeTransport, activeTransport: () => NativeTransport, projectControls: WeakMap<NativeTransport, ProjectControls>, addNotice: Notice) {
  const current = () => activeTransport() === transport;

  if (!current() || !transport.ownsConversation()) return;

  if (transport.currentHostId() !== "local") value = await transport.loadHostSettings();

  if (!current()) return;
  const hiddenModels = value.hiddenModels;
  transport.setDefaultFastMode(value.defaultFastMode);

  await transport.configureAutomaticBehavior(value.autoRetry);

  if (!current()) return;
  const inherited = projectControls.get(transport);

  if (!inherited && !transport.needsDefaults()) return;
  const availableModels = await transport.command({ type: "get_available_models" }, z.object({ models: z.array(modelSchema) })).then(result => result.models);

  if (!current()) return;

  if (inherited) {
    await applyInherited(transport, inherited, value.defaultModel, availableModels, hiddenModels, addNotice);
    projectControls.delete(transport); transport.defaultsApplied();

    return;
  }

  await applyDefaults(transport, value, availableModels, hiddenModels, current, addNotice);
}
