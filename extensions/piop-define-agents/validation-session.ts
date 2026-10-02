import type { ExtensionContext, ExtensionRunner, ExtensionRuntime, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Agent } from "./contracts.ts";
import { agentThinkingLevels } from "./state.ts";

export function bindValidationSession(runtime: ExtensionRuntime, runner: ExtensionRunner, session: SessionManager, registry: ModelRegistry, agent: Agent, settings: ReturnType<ExtensionRuntime["getSettings"]>) {
  let activeTools = [...agent.tools];
  let thinking = agentThinkingLevels.find(level => level === agent.effort) ?? "off";
  const [provider, ...parts] = agent.model.split("/");
  let model: ExtensionContext["model"] = registry.find(provider, parts.join("/"));
  runner.bindCore({
    ...runtime,
    getSettings: () => structuredClone(settings),
    getActiveTools: () => [...activeTools],
    setActiveTools: names => { activeTools = [...names]; },
    appendEntry: (type, data) => { session.appendCustomEntry(type, data); },
    setSessionName: name => { session.appendSessionInfo(name); },
    getSessionName: () => session.getSessionName(),
    setLabel: (id, label) => { session.appendLabelChange(id, label); },
    sendMessage: message => { session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
    sendUserMessage: content => { session.appendMessage({ role: "user", content, timestamp: Date.now() }); },
    setModel: async candidate => {
      const available = registry.find(candidate.provider, candidate.id);

      if (!available) return false;
      model = available;

      return true;
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel: level => { thinking = level; },
  }, {
    getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
    getSignal: () => undefined, abort: () => {}, hasPendingMessages: () => false, shutdown: () => {},
    getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => "",
  });
}
