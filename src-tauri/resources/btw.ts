import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DESKTOP_TITLE = "__pi_desktop_btw__";
const MESSAGE_TITLE = "__pi_desktop_btw_message__";
const MESSAGE_TOOL = "message_main_chat";

function isSideConversation(ctx: ExtensionContext) {
  return /(?:^|[\\/])pi-desktop-btw-[^/\\]+\.jsonl$/.test(ctx.sessionManager.getSessionFile() ?? "") && !!ctx.sessionManager.getHeader()?.parentSession;
}

function registerParentMessaging(pi: ExtensionAPI) {
  pi.registerTool({
    name: MESSAGE_TOOL, label: "Message main chat",
    description: "Send a message from this /btw side conversation to its original main chat. The message is queued if the main agent is busy. Returns after delivery, without waiting for a reply. Send only the information you want the main agent to receive.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!isSideConversation(ctx)) throw new Error("This tool is only available in /btw conversations");
      if (!params.message.trim()) throw new Error("A message is required");
      const response = await ctx.ui.input(MESSAGE_TITLE, JSON.stringify({ message: params.message, parentSession: ctx.sessionManager.getHeader()?.parentSession }), { signal });
      if (response !== "delivered") throw new Error(response || "Message delivery cancelled");
      return { content: [{ type: "text", text: "Message delivered to the main chat." }], details: {} };
    },
  });
  const stop = pi.events.on("piop:required-tools", (value) => {
    const request = value as { ctx: ExtensionContext; tools: string[] };
    if (isSideConversation(request.ctx)) request.tools.push(MESSAGE_TOOL);
  });
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getActiveTools().filter((name) => name !== MESSAGE_TOOL);
    if (isSideConversation(ctx)) tools.push(MESSAGE_TOOL);
    pi.setActiveTools(tools);
  });
  pi.on("session_shutdown", stop);
}

export default function btwExtension(pi: ExtensionAPI) {
  registerParentMessaging(pi);
  pi.registerCommand("btw", {
    description: "Open an ephemeral side conversation branched from the current response",
    handler: async (rawArgs, ctx) => {
      const task = rawArgs.trim();
      if (!task) {
        ctx.ui.notify("/btw needs a message to send", "warning");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("/btw needs a persisted session to branch from", "error");
        return;
      }

      const parentLeafId = ctx.sessionManager.getLeafId();
      ctx.ui.setStatus("btw", "Running side conversation…");
      void (async () => {
        try {
          await ctx.ui.input(DESKTOP_TITLE, JSON.stringify({ task, sessionFile, leafId: parentLeafId, cwd: ctx.cwd }));
        } catch (error) {
          ctx.ui.notify(`/btw failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus("btw", undefined);
        }
      })();
    },
  });
}
