import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";

export interface PromptTools {
  register(tool: string, keep: () => boolean): () => void;
  show(tool: string): void;
}

export interface PromptToolsRequest { tools?: PromptTools }

interface RequiredToolsRequest { ctx: ExtensionContext; tools: string[]; withheldTools: string[]; availableTools?: string[] }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:session:prompt-tools", handler: (request: PromptToolsRequest) => void): () => void;
    emit(channel: "piop:session:prompt-tools", request: PromptToolsRequest): void;
    on(channel: "piop:required-tools", handler: (request: RequiredToolsRequest) => void): () => void;
    emit(channel: "piop:required-tools", request: RequiredToolsRequest): void;
  }
}

export function promptTools(pi: ExtensionAPI): PromptTools {
  const request: PromptToolsRequest = {};
  pi.events.emit("piop:session:prompt-tools", request);
  if (!request.tools) throw new Error("The Piop session core is not loaded, so tools cannot enter the prompt");

  return request.tools;
}

function transcript(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  const messages = branch.flatMap(entry => entry.type === "message" ? [entry.message] : []);
  const compaction = branch.findLastIndex(entry => entry.type === "compaction");
  const reply = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant");

  return { tools: new Set(getCurrentTools(messages).map(tool => tool.name)), compacted: compaction > reply };
}

export function registerPromptTools(pi: ExtensionAPI) {
  const registered = new Map<string, { keep: () => boolean; shown: boolean }>();
  let recheck = false;
  let opened = false;
  let running = false;

  const sync = (tool: string) => {
    const state = registered.get(tool);
    if (!state) return;
    const active = pi.getActiveTools();

    if (state.shown !== active.includes(tool)) pi.setActiveTools(state.shown ? [...active, tool] : active.filter(name => name !== tool));
  };

  const review = () => {
    const compacted = recheck;

    if (!compacted && !opened) return;
    recheck = false; opened = false;

    for (const [tool, state] of registered) {
      const keep = state.keep();

      if (keep !== state.shown && (keep || compacted)) { state.shown = keep; sync(tool); }
    }
  };

  const tools: PromptTools = {
    register(tool, keep) {
      if (registered.has(tool)) throw new Error(`${tool} is already registered as a prompt tool`);
      registered.set(tool, { keep, shown: false });

      return () => { registered.delete(tool); };
    },
    show(tool) {
      const state = registered.get(tool);
      if (!state) throw new Error(`${tool} is not registered as a prompt tool`);
      if (state.shown) return;
      state.shown = true; sync(tool);
    },
  };

  const restore = (ctx: ExtensionContext) => {
    const saved = transcript(ctx);
    recheck = saved.compacted; opened = true;

    for (const [tool, state] of registered) { state.shown = saved.tools.has(tool); sync(tool); }
  };

  const offRequest = pi.events.on("piop:session:prompt-tools", request => { request.tools = tools; });
  const offRequired = pi.events.on("piop:required-tools", request => {
    for (const [tool, state] of registered) (state.shown ? request.tools : request.withheldTools).push(tool);
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", () => { recheck = true; if (running) review(); });
  pi.on("before_agent_start", () => { review(); });
  pi.on("agent_start", () => { running = true; });
  pi.on("agent_settled", () => { running = false; });
  pi.on("session_shutdown", () => { offRequest(); offRequired(); });

  return { has: (tool: string) => registered.has(tool) };
}

const definitions = Schema.Array(Schema.Object({
  name: Schema.String({ minLength: 1 }), label: Schema.String(), description: Schema.String(), parameters: Schema.Record(Schema.String(), Schema.Unknown()),
  exposure: Schema.Optional(Schema.Union([Schema.Literal("direct"), Schema.Literal("model-only")])),
}));

const answer = Schema.Object({ text: Schema.String(), details: Schema.Unknown() });

export function registerQueueTools(pi: ExtensionAPI) {
  const tools = Parse(definitions, JSON.parse(process.env.PIOP_QUEUE_TOOLS ?? "[]"));
  const kept = new Map<string, boolean>();
  const prompt = promptTools(pi);
  const removals: Array<() => void> = [];

  for (const tool of tools) {
    pi.registerTool({
      ...tool,
      parameters: tool.parameters as never,
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value as ((name: string, data: unknown) => Promise<unknown>) | undefined;

        if (!send) throw new Error("Piop runtime events are unavailable");
        const result = Parse(answer, await send("queue_tool", { tool: tool.name, params }));

        return { content: [{ type: "text" as const, text: result.text }], details: result.details };
      },
    });
    removals.push(prompt.register(tool.name, () => kept.get(tool.name) === true));
  }

  const off = pi.events.on("piop:rpc", request => {
    if (request.command !== "queue_tools") return;
    const state = request.payload as Record<string, unknown>;

    for (const tool of tools) {
      const keep = state?.[tool.name] === true;
      kept.set(tool.name, keep);

      if (keep) prompt.show(tool.name);
    }
  });

  pi.on("session_shutdown", () => { off(); for (const remove of removals) remove(); });
}

type RuntimeEventSender = (name: string, data: unknown) => Promise<void>;

export function registerToolInventory(pi: ExtensionAPI, promptTools: { has(tool: string): boolean }) {
  const agentSources = new Set([process.env.PI_DESKTOP_DEFINED_AGENTS_EXTENSION, process.env.PIOP_MCP_EXTENSION].filter((path): path is string => Boolean(path)));

  pi.events.on("piop:rpc", request => {
    if (request.command !== "session_ready") return;
    const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value as RuntimeEventSender | undefined;

    if (!send) throw new Error("Piop runtime events are unavailable");
    const tools = pi.getAllTools()
      .filter(tool => !agentSources.has(tool.sourceInfo.path) && !promptTools.has(tool.name))
      .map(tool => ({ name: tool.name, description: tool.description ?? "", source: tool.sourceInfo.path }));
    void send("tools_available", { tools }).catch(error => console.error(`Piop could not save the tools of this Pi: ${error instanceof Error ? error.message : String(error)}`));
  });
}
