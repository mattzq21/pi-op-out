import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isAuxiliary } from "../../resources/piop-storage/session-records.cjs";
import { sessionControls } from "../../resources/piop-controls/interface.ts";
import { openAuxiliaryChat } from "../../resources/session-broker/auxiliary.ts";

const NOTE = "This is a side chat of the main chat. Use send_to_main to send results there.";

/** The name the chat list shows: the saved name, or else the first line of the first prompt. */
function mainChatName(ctx: ExtensionCommandContext) {
  const saved = ctx.sessionManager.getSessionName()?.trim();

  if (saved) return saved;
  const first = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
  const content = first?.type === "message" && first.message.role === "user" ? first.message.content : "";
  const text = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join(" ");

  return text.trim().split("\n")[0]?.trim() || "chat";
}

async function startBtw(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
  if (isAuxiliary(ctx.sessionManager.getEntries())) throw new Error("/btw is not available in a side chat");
  const controls = sessionControls(pi);

  if (!controls) throw new Error("Piop session controls are not loaded");
  const name = `btw ${mainChatName(ctx)}`;
  const copy = await controls.copyAuxiliary(ctx, { kind: "btw", name, note: NOTE });
  const task = args.trim();

  openAuxiliaryChat(ctx, { kind: "btw", name, sessionId: copy.sessionId, sessionPath: copy.sessionPath, cwd: copy.cwd, hostId: copy.hostId, parentSessionId: copy.parentSessionId, ...task ? { task } : {} });
}

/** /btw: a side chat with this chat's history through its last finished answer, opened in the side pane. */
export default function btw(pi: ExtensionAPI) {
  const unsubscribe = pi.events.on("piop:auxiliary:kind", request => { if (request.kind === "btw") request.sendToMain = "Send results to the main chat."; });
  pi.on("session_shutdown", () => { unsubscribe(); });
  pi.registerCommand("btw", {
    description: "Ask a side question in a side chat that knows this chat",
    getArgumentCompletions: prefix => prefix.trim() ? null : [{ value: "", label: "[question]", description: "Optional. The first message of the side chat" }],
    handler: async (args, ctx) => {
      try { await startBtw(pi, args, ctx); }
      catch (error) { ctx.ui.notify(`/btw failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });
}
