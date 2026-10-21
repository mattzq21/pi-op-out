import { z } from "zod";
import { ReviewFeedback } from "./ReviewFeedback";
import type { SplitPaneRequestHandler } from "../types";

const optionalString = z.string().optional().catch(undefined);

const reviewPayloadSchema = z.object({ task: optionalString, cwd: optionalString, parentSessionId: optionalString, sessionId: optionalString, sessionPath: optionalString, hostId: optionalString, readOnly: z.boolean().optional(), archived: z.boolean().optional(), inherited: z.boolean().optional(), images: z.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), name: z.string().optional() })).optional() });

function parseReviewPayload(placeholder?: string) {
  const payload = reviewPayloadSchema.parse(JSON.parse(placeholder || "{}"));

  if (!payload.parentSessionId) throw new Error("Invalid /review request");

  if (payload.sessionId === undefined || !payload.sessionPath) throw new Error("Missing saved review session");

  return { ...payload, task: payload.readOnly ? undefined : payload.task, parentSessionId: payload.parentSessionId, sessionId: payload.sessionId, sessionPath: payload.sessionPath };
}

export const parseReviewRequest: SplitPaneRequestHandler["open"] = (request, options) => {
  const payload = parseReviewPayload(request.placeholder);
  const cwd = payload.cwd || ".";
  const hostId = payload.hostId ?? options.activeHostId;
  const inheritedParent = payload.inherited || payload.readOnly && !payload.archived ? payload.parentSessionId : undefined;

  const messageMain = async (message: string) => {
    if (options.parent.connectionTarget().sessionId !== payload.parentSessionId) throw new Error("The original main conversation is no longer connected");
    await options.parent.command({ type: "review_feedback", sessionId: payload.sessionId, message });
  };

  return {
    session: { id: payload.sessionId, path: payload.sessionPath, name: "Code review", project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, preview: payload.task ?? "Code review", messageCount: 0, lastMessageAt: Date.now(), apiCost: 0, hostId },
    request: {
      requestId: request.id,
      readOnly: Boolean(inheritedParent || payload.archived),
      initialPrompt: payload.task,
      initialImages: payload.readOnly ? undefined : payload.images ?? options.pendingImages,
      actions: payload.readOnly ? undefined : controls => <ReviewFeedback {...controls} messageMain={messageMain} />,
      notice: props => <>
        {inheritedParent && <div class="split-pane-status" role="status">Inherited review, opened read-only. Feedback belongs to the original conversation ({inheritedParent}). Open that conversation to send feedback.</div>}
        {payload.archived && <div class="split-pane-status" role="status">This review is archived and read-only. <button type="button" onClick={props.onShowArchive}>Open archived sessions to restore it</button></div>}
      </>,
    },
  };
};

export const reviewSplitPane: SplitPaneRequestHandler = {
  title: "__pi_desktop_review__",
  command: "/review",
  commands: ["review", "rs"],
  rejectInSplit: "To start /review from this conversation, select it in the main pane first.",
  open: parseReviewRequest,
};
