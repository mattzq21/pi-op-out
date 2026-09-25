import { encodeAgentValue } from "./lib/agentProtocol";
import type { NativeTransport } from "./lib/nativeTransport";
import { VOICE_ORCHESTRATOR_AGENT } from "./lib/orchestrator";
import type { AppSettings, Model } from "./types";

export type ProjectControls = { agent?: string; model: Model | null; thinking: string };
const selectableAgent = (agent: string) => agent === VOICE_ORCHESTRATOR_AGENT ? "general" : agent;

export function reassignTerminals(transport: NativeTransport, terminals: readonly { id: string; started: boolean }[], sessionKey: string, onError: (reason: unknown) => void) {
  for (const terminal of terminals) {
    if (terminal.started) void transport.reassignTerminal(terminal.id, sessionKey).catch(onError);
  }
}

async function applyInherited(transport: NativeTransport, inherited: ProjectControls, models: Model[]) {
  if (inherited.agent) await transport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(selectableAgent(inherited.agent))}` });
  if (inherited.model && models.some((model) => model.provider === inherited.model!.provider && model.id === inherited.model!.id)) {
    await transport.command({ type: "set_model", provider: inherited.model.provider, modelId: inherited.model.id });
  }
  const { levels } = await transport.command<{ levels: string[] }>({ type: "get_available_thinking_levels" });
  if (levels.includes(inherited.thinking)) await transport.command({ type: "set_thinking_level", level: inherited.thinking });
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
  await transport.command({ type: "prompt", message: `/pi-define-agents-use ${encodeAgentValue(selectableAgent(value.defaultAgent ?? "general"))}` });
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
