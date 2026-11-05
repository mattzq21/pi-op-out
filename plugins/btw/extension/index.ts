import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import { isAuxiliary, sessionName } from "../../../daemon/resources/piop-storage/index.ts";
import { sessionControls } from "../../../daemon/resources/piop-controls/index.ts";
import { openAuxiliaryChat, slashCommand } from "../../../daemon/resources/session-broker/index.ts";

const queuedRequestSchema = Schema.Object({ command: Schema.Literal("btw"), args: Schema.String(), images: Schema.Array(Schema.Object({ type: Schema.Literal("image"), data: Schema.String(), mimeType: Schema.String(), name: Schema.Optional(Schema.String()) })) });

type Images = Array<{ type: "image"; data: string; mimeType: string; name?: string }>;

function mainChatName(ctx: ExtensionCommandContext) {
  const file = ctx.sessionManager.getSessionFile();
  const saved = file ? sessionName(file, ctx.sessionManager.getSessionId()) : undefined;

  if (saved) return saved;
  const first = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
  const content = first?.type === "message" && first.message.role === "user" ? first.message.content : "";
  const text = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join(" ");

  return text.trim().split("\n")[0]?.trim() || "chat";
}

async function startBtw(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, images?: Images) {
  if (isAuxiliary(ctx.sessionManager.getEntries())) throw new Error("/btw is not available in a side chat");
  const controls = sessionControls(pi);

  if (!controls) throw new Error("Piop session controls are not loaded");
  const name = `btw ${mainChatName(ctx)}`;
  const copy = await controls.copyAuxiliary(ctx, { kind: "btw", name });
  const task = args.trim();

  openAuxiliaryChat(ctx, { kind: "btw", name, sessionId: copy.sessionId, sessionPath: copy.sessionPath, cwd: copy.cwd, hostId: copy.hostId, parentSessionId: copy.parentSessionId, ...task ? { task, background: true } : {}, ...task && images?.length ? { images } : {} });
}

export default function btw(pi: ExtensionAPI) {
  const unsubscribe = pi.events.on("piop:auxiliary:kind", request => { if (request.kind === "btw") request.sendToMain = "Send results to the main chat. Use only when user explicitly asks to communicate with the other chat"; });
  const unsubscribeQueued = pi.events.on("piop:rpc", request => {
    if (slashCommand(request) !== "btw") return;
    request.ready = (async () => {
      const payload = Parse(queuedRequestSchema, request.payload);
      await startBtw(pi, payload.args, request.ctx, payload.images);
    })();
  });
  pi.on("session_shutdown", () => { unsubscribe(); unsubscribeQueued(); });
  pi.registerCommand("btw", {
    description: "Ask a side question in a side chat that knows this chat",
    getArgumentCompletions: prefix => prefix.trim() ? null : [{ value: "", label: "[question]", description: "Optional. The first message of the side chat" }],
    handler: async (args, ctx) => {
      try { await startBtw(pi, args, ctx); }
      catch (error) { ctx.ui.notify(`/btw failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });
}
