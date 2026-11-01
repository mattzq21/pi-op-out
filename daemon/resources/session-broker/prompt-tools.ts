import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";

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
