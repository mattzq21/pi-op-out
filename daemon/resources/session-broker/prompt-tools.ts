import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";

/**
 * Core: tools that are in the prompt only while a plugin needs them. A registered tool stays out of the prompt until show().
 * On the first message after a compaction, each shown tool whose keep() is false leaves the prompt. Between compactions
 * the prompt does not lose tools, so the model provider can reuse its cache. On the first message after the chat opens,
 * each tool whose keep() is true enters the prompt, so plugins may load their state at any point before that message.
 */
export interface PromptTools {
  /** keep tells whether the tool must be in the prompt after a compaction or when the chat opens. Returns the function that removes the registration. */
  register(tool: string, keep: () => boolean): () => void;
  /** Puts a registered tool in the prompt, if the agent's tools include it. */
  show(tool: string): void;
  /** The agent's tools include the tool, and it is in the prompt when shown. */
  allowed(tool: string): boolean;
}

/** Extensions emit this request on "piop:session:prompt-tools" to get the core PromptTools. */
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

/** The core PromptTools. Throws when the core session broker is not loaded. */
export function promptTools(pi: ExtensionAPI): PromptTools {
  const request: PromptToolsRequest = {};
  pi.events.emit("piop:session:prompt-tools", request);
  if (!request.tools) throw new Error("The Piop session core is not loaded, so tools cannot enter the prompt");

  return request.tools;
}

/** From the transcript: the tools in the prompt, and whether a compaction came after the last model reply. */
function transcript(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  const messages = branch.flatMap(entry => entry.type === "message" ? [entry.message] : []);
  const compaction = branch.findLastIndex(entry => entry.type === "compaction");
  const reply = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant");

  return { tools: new Set(getCurrentTools(messages).map(tool => tool.name)), compacted: compaction > reply };
}

export function registerPromptTools(pi: ExtensionAPI) {
  const registered = new Map<string, { keep: () => boolean; shown: boolean; permitted: boolean }>();
  /** A compaction happened and the next message has not started yet. */
  let recheck = false;
  /** The chat opened and its first message has not started yet. */
  let opened = false;
  let running = false;

  const sync = (tool: string) => {
    const state = registered.get(tool);
    if (!state) return;
    const active = pi.getActiveTools();
    const wanted = state.shown && state.permitted;

    if (wanted !== active.includes(tool)) pi.setActiveTools(wanted ? [...active, tool] : active.filter(name => name !== tool));
  };

  /** Asks keep() of each tool: a tool that must stay enters the prompt, and after a compaction a tool that need not stay leaves it. */
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
      registered.set(tool, { keep, shown: false, permitted: false });

      return () => { registered.delete(tool); };
    },
    show(tool) {
      const state = registered.get(tool);
      if (!state) throw new Error(`${tool} is not registered as a prompt tool`);
      if (state.shown) return;
      state.shown = true; sync(tool);
    },
    allowed(tool) {
      const state = registered.get(tool);

      return !!state?.permitted && (!state.shown || pi.getActiveTools().includes(tool));
    },
  };

  /** Until the first message, the prompt keeps the tools that the transcript has. */
  const restore = (ctx: ExtensionContext) => {
    const saved = transcript(ctx);
    recheck = saved.compacted; opened = true;

    for (const [tool, state] of registered) { state.shown = saved.tools.has(tool); sync(tool); }
  };

  const offRequest = pi.events.on("piop:session:prompt-tools", request => { request.tools = tools; });
  const offRequired = pi.events.on("piop:required-tools", request => {
    for (const [tool, state] of registered) {
      state.permitted = request.availableTools?.includes(tool) ?? false;

      if (!state.shown) request.withheldTools.push(tool);
    }
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  // A compaction during a run comes right before the next model request; between runs, the next run's start decides.
  pi.on("session_compact", () => { recheck = true; if (running) review(); });
  pi.on("before_agent_start", () => { review(); });
  pi.on("agent_start", () => { running = true; });
  pi.on("agent_settled", () => { running = false; });
  pi.on("session_shutdown", () => { offRequest(); offRequired(); });
}
