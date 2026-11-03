import type { AppSettings, ImageAttachment, SessionSummary } from "../types";
import type { createConversationDrafts } from "../appDrafts";
import type { NativeTransport } from "./nativeTransport";
import type { SessionRuntimePool } from "./sessionRuntimePool";
import { draftUploadsFromImages, stageDraftSubmission, submitDraftPrompt } from "./draftSubmission";
import { agentStateSchema } from "./responseSchemas";
import { trackChatSubmission } from "./chatSubmission";

export async function sendFirstMessageHidden(options: { runtimePool: SessionRuntimePool; drafts: ReturnType<typeof createConversationDrafts>; settings: AppSettings; session: SessionSummary; prompt: string; images: ImageAttachment[] }): Promise<NativeTransport> {
  const { runtimePool, session, prompt, images } = options;
  const transport = runtimePool.forPluginPane(session);
  options.drafts.bindTransport(transport, `${session.hostId ?? "local"}:${session.id}`);
  const releaseHold = runtimePool.hold(transport);

  try {
    await transport.connect();

    if (transport.ownsConversation()) {
      const settings = transport.currentHostId() === "local" ? options.settings : await transport.loadHostSettings();
      await transport.configureAutomaticBehavior(settings.autoRetry);
    }
    const state = await transport.command({ type: "get_state" }, agentStateSchema);

    if (state.model) transport.promptControls.useEffectiveModel(state.model);
    const staged = await stageDraftSubmission(transport, { rawText: prompt, uploads: draftUploadsFromImages(images), consume: false });
    await trackChatSubmission(transport, prompt, images, staged, () => submitDraftPrompt(transport, { type: "prompt", message: prompt, images }));
  } finally { releaseHold(); }

  return transport;
}
