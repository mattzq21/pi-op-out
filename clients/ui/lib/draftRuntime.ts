import { modelLevels } from "./promptControls";
import { z } from "zod";
import { nativeCall } from "./nativeCall";
import { captureDaemonTransport } from "./platform";
import { agentConfigSchema } from "./agentSchemas";
import { modelSchema } from "./responseSchemas";
import { encodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "./agentProtocol";
import type { AgentState, RpcCommand, RpcEvent } from "../types";

const catalogSchema = z.object({ config: agentConfigSchema, models: z.array(modelSchema), commands: z.array(z.string()) });

const catalogs = new Map<string, Promise<z.infer<typeof catalogSchema>>>();

export function clearDraftCatalogs() { catalogs.clear(); }

function loadCatalog(hostId: string) {
  const connection = captureDaemonTransport();
  const key = JSON.stringify([connection.identity, hostId]);
  const cached = catalogs.get(key);

  if (cached) return cached;

  const pending = nativeCall("provider_auth", { hostId, request: { action: "draft_catalog" } }, catalogSchema).catch(reason => {
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
  fastMode = false;

  constructor(private hostId: () => string, private emit: (event: RpcEvent) => void) {}

  async load() {
    this.catalog = await loadCatalog(this.hostId());
  }

  async command(command: RpcCommand) {
    await this.load();
    const type = command.type;

    if (type === "get_available_models") return { models: this.catalog?.models };

    if (type === "get_available_thinking_levels") return { levels: this.levels() };

    if (type === "get_commands") return { commands: this.catalog?.commands.map(name => ({ name, source: "extension" })) };

    if (type === "get_state") return this.state;

    if (type === "get_session_stats") return {};

    if (type === "get_session_revision") return { revision: String(this.revision) };

    if (type === "get_snapshot") return { revision: String(this.revision), state: this.state, history: { entries: [], leafId: null }, sequence: 0, epoch: "draft", liveTools: [], queue: { type: "queue_update", steering: [], followUp: [], pendingMessages: [] } };

    return this.change(command);
  }

  private levels() { return this.state.model ? modelLevels(this.state.model) : ["off"]; }

  private change(command: RpcCommand) {
    if (command.type === "get_agent_configuration") return this.catalog?.config;

    if (command.type === "select_agent") return this.selectAgent(z.string().parse(command.agent));

    if (command.type === "set_model") {
      const model = this.catalog?.models.find(model => model.provider === command.provider && model.id === command.modelId);

      if (!model) throw new Error("The selected model is unavailable");
      this.state = { ...this.state, model };
    } else if (command.type === "set_thinking_level") this.state = { ...this.state, thinkingLevel: z.string().parse(command.level) };
    else if (!["set_auto_compaction", "set_auto_retry"].includes(command.type)) throw new Error("Send the first message before using this action");
    this.changes.set(command.type, command); this.revision++;

    return {};
  }

  private selectAgent(name: string) {
    const agent = this.catalog?.config.agents.find(agent => agent.name === name);

    if (!agent) throw new Error("The selected agent is unavailable");
    this.agent = name;
    const model = this.catalog?.models.find(model => `${model.provider}/${model.id}` === agent.model);
    this.state = { ...this.state, model: model ?? this.state.model, thinkingLevel: agent.effort || this.state.thinkingLevel };
    this.fastMode = agent.fastMode ?? false;
    this.changes.delete("set_model"); this.changes.delete("set_thinking_level");
    this.changes.set("select_agent", { type: "select_agent", agent: name }); this.revision++;
    this.emit({ type: "extension_ui_request", method: "setStatus", statusKey: DEFINED_AGENTS_STATUS_KEY, statusText: encodeAgentValue({ version: 1, active: this.agent, locked: false, saved: false, config: this.catalog?.config ?? { agents: [] } }) });

    return {};
  }
}
