import { clampEffort, modelLevels } from "./promptControls";
import { z } from "zod";
import { nativeCall } from "./nativeCall";
import { captureDaemonTransport } from "./platform";
import { agentConfigSchema } from "./agentSchemas";
import { modelSchema } from "./responseSchemas";
import { encodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "./agentProtocol";
import type { AgentState, RpcCommand, RpcEvent } from "../types";

const catalogSchema = z.object({ config: agentConfigSchema, models: z.array(modelSchema), initialModel: z.string().nullable(), initialThinking: z.string(), commands: z.array(z.string()), commandDetails: z.array(z.object({ name: z.string(), description: z.string().optional(), options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional() })) });

const catalogs = new Map<string, Promise<z.infer<typeof catalogSchema>>>();

export function clearDraftCatalogs() { catalogs.clear(); }

function loadCatalog(hostId: string, reload = false) {
  const connection = captureDaemonTransport();
  const key = JSON.stringify([connection.identity, hostId]);
  const cached = catalogs.get(key);

  if (cached && !reload) return cached;

  const pending = nativeCall("provider_auth", { hostId, request: { action: "draft_catalog", reload } }, catalogSchema).catch(reason => {
    if (catalogs.get(key) === pending) catalogs.delete(key);

    throw reason;
  });

  catalogs.set(key, pending);

  return pending;
}

export class DraftRuntime {
  private state: AgentState = { model: null, thinkingLevel: "off", sessionId: "", messageCount: 0, pendingMessageCount: 0, isStreaming: false };
  private catalog?: z.infer<typeof catalogSchema>;
  private agent = "general";
  private revision = 0;
  readonly changes = new Map<string, RpcCommand>();
  private fast = false;
  defaultFastMode = false;
  /** The settings fallbacks for the default agent. Set once the draft shows the host's default agent. */
  private defaults?: { thinking: string; fastMode: boolean };
  /** True after the user changes the agent, model, thinking level or fast mode. A changed draft keeps its choices when the host's default agent changes. */
  private chosen = false;

  constructor(private hostId: () => string, private emit: (event: RpcEvent) => void) {}

  get fastMode() { return this.fast; }

  /** The user's fast mode choice for this draft. */
  setFastMode(enabled: boolean) { this.fast = enabled; this.chosen = true; }

  async load() {
    this.catalog = await loadCatalog(this.hostId());
  }

  /** Reads the agent definitions on the host again and publishes the new list while `current` still returns true. A draft the user has not changed shows the new default agent. */
  async reload(current: () => boolean) {
    const catalog = await loadCatalog(this.hostId(), true);

    if (!current()) throw new Error("The conversation started before agent definitions finished reloading. Reload them again.");
    this.catalog = catalog;

    if (this.defaults && !this.chosen) this.showDefault(this.defaults);
    else this.publishAgents();
  }

  async command(command: RpcCommand) {
    await this.load();
    const type = command.type;

    if (type === "get_available_models") return { models: this.catalog?.models };

    if (type === "get_available_thinking_levels") return { levels: this.levels() };

    if (type === "get_commands") return { commands: this.catalog?.commands.map(name => ({ ...this.catalog?.commandDetails.find(command => command.name === name), name, source: "extension" })) };

    if (type === "get_state") return this.state;

    if (type === "get_session_stats") return {};

    if (type === "get_session_revision") return { revision: String(this.revision) };

    if (type === "get_snapshot") return { revision: String(this.revision), state: this.state, history: { entries: [], leafId: null }, sequence: 0, epoch: "draft", liveTools: [], queue: { type: "queue_update", steering: [], followUp: [], pendingMessages: [] } };

    return this.change(command);
  }

  private levels() { return this.state.model ? modelLevels(this.state.model) : ["off"]; }

  /** Shows the host's default agent with its own model, effort, and fast mode. */
  async applyDefaults(thinking: string, fastMode: boolean) {
    await this.load();
    this.defaults = { thinking, fastMode }; this.chosen = false;
    this.showDefault(this.defaults);
  }

  /** Records the shown default agent, so the session starts as this agent even if the host's default changes before sending. */
  private showDefault({ thinking, fastMode }: { thinking: string; fastMode: boolean }) {
    const agent = this.catalog?.config.agents.find(agent => agent.isDefault);

    if (!agent) throw new Error("This host has no default agent");
    this.agent = agent.name;
    // An agent without its own model uses the model Pi starts with on this host.
    const name = agent.model || this.catalog?.initialModel;
    const model = this.catalog?.models.find(model => `${model.provider}/${model.id}` === name) ?? null;
    // Piop starts Pi with the default thinking level from Settings when it has one; else Pi uses its own. Pi then limits the level to what the model supports.
    const level = agent.effort || thinking || this.catalog?.initialThinking || "medium";
    this.state = { ...this.state, model, thinkingLevel: model ? clampEffort(level, model) : "off" };
    this.fast = agent.fastMode ?? fastMode;
    this.changes.delete("set_model"); this.changes.delete("set_thinking_level");
    this.changes.set("select_agent", { type: "select_agent", agent: agent.name }); this.revision++;
    this.emit({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey: "pi-desktop-fast-mode", statusText: this.fast ? "Fast mode on" : "Fast mode off" });
    this.publishAgents();
  }

  private change(command: RpcCommand) {
    if (command.type === "get_agent_configuration") return this.catalog?.config;

    if (command.type === "select_agent") return this.selectAgent(z.string().parse(command.agent));

    if (command.type === "set_model") {
      const model = this.catalog?.models.find(model => model.provider === command.provider && model.id === command.modelId);

      if (!model) throw new Error("The selected model is unavailable");
      this.state = { ...this.state, model };
    } else if (command.type === "set_thinking_level") this.state = { ...this.state, thinkingLevel: z.string().parse(command.level) };
    else if (!["set_auto_compaction", "set_auto_retry"].includes(command.type)) throw new Error("Send the first message before using this action");

    if (command.type === "set_model" || command.type === "set_thinking_level") this.chosen = true;
    this.changes.set(command.type, command); this.revision++;

    return {};
  }

  private selectAgent(name: string) {
    const agent = this.catalog?.config.agents.find(agent => agent.name === name);

    if (!agent) throw new Error("The selected agent is unavailable");
    this.agent = name; this.chosen = true;
    const model = this.catalog?.models.find(model => `${model.provider}/${model.id}` === agent.model);
    this.state = { ...this.state, model: model ?? this.state.model, thinkingLevel: agent.effort || this.state.thinkingLevel };
    this.fast = agent.fastMode ?? this.defaultFastMode;
    this.changes.delete("set_model"); this.changes.delete("set_thinking_level");
    this.changes.set("select_agent", { type: "select_agent", agent: name }); this.revision++;
    // An agent without its own model or effort keeps the shown ones. The chat must start with what the composer shows.
    if (!model && this.state.model) this.changes.set("set_model", { type: "set_model", provider: this.state.model.provider, modelId: this.state.model.id });
    if (!agent.effort) this.changes.set("set_thinking_level", { type: "set_thinking_level", level: this.state.thinkingLevel });
    this.emit({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey: "pi-desktop-fast-mode", statusText: this.fastMode ? "Fast mode on" : "Fast mode off" });
    this.publishAgents();

    return {};
  }

  private publishAgents() {
    const config = this.catalog?.config ?? { agents: [] };
    const capability = { version: 1, active: this.agent, locked: false, saved: false, unavailable: !config.agents.some(agent => agent.name === this.agent), config };
    this.emit({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey: DEFINED_AGENTS_STATUS_KEY, statusText: `json:${encodeAgentValue(capability)}` });
  }
}
