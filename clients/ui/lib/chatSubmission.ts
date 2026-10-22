import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js";
import type { NativeTransport } from "./nativeTransport";
import type { ChatMessage, ImageAttachment } from "../types";
import { ownDraftSubmission, releaseDraftSubmission, type DraftSubmissionHandle } from "./draftSubmission";
import { discardSubmittedMessage, retainSubmittedMessage } from "./sessionMemory";
import { CommandRejectedError } from "./commandRejected";

type Submission = { owner: NativeTransport; message: ChatMessage; status: string; durable: DraftSubmissionHandle };

const [submissions, setSubmissions] = createSignal<Submission[]>([]);

export const chatSubmission = (owner?: NativeTransport) => submissions().find(submission => submission.owner === owner);

export const isChatSubmissionActive = (id: string) => submissions().some(submission => submission.durable.id === id);

export function updateChatPreparation(owner: NativeTransport, status: string) {
  if (chatSubmission(owner)?.status === status) return;
  setSubmissions(current => current.map(item => item.owner === owner ? { ...item, status } : item));
}

export async function trackChatSubmission<T>(owner: NativeTransport, text: string, images: ImageAttachment[], durable: DraftSubmissionHandle, work: () => Promise<T>, initialStatus = "Sending message…", behavior?: "steer" | "followUp") {
  const message: ChatMessage = { id: durable.id, role: "user", content: [{ type: "text", text }, ...images], deliveryBehavior: behavior };
  setSubmissions(current => [...current, { owner, message, durable, status: initialStatus }]);
  retainSubmittedMessage(owner, message);
  ownDraftSubmission(durable);
  let retain = false;

  try {
    const result = await work();

    if (result === false) await durable.reject("Message was not submitted");
    else await durable.accept();
    retain = result !== false && !text.trimStart().startsWith("/");

    return result;
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason);

    const uncertain = durable.wasDispatched() && !(reason instanceof CommandRejectedError);

    if (uncertain) await durable.uncertain(error);
    else await durable.reject(error);
    retain = uncertain && !text.trimStart().startsWith("/");
    throw reason;
  } finally {
    releaseDraftSubmission(durable, owner);
    releaseDraftSubmission(durable);

    if (!retain) {
      discardSubmittedMessage(owner, durable.id);
      discardSubmittedMessage(durable.owner(), durable.id);
    }

    setSubmissions(current => current.filter(item => item.message !== message));
  }
}

export function waitForConversationReady(owner: NativeTransport, active: Accessor<NativeTransport>, ready: Accessor<boolean>, error: Accessor<string | undefined>) {
  if (!ready()) updateChatPreparation(owner, "Getting ready...");

  return new Promise<void>((resolve, reject) => createRoot((dispose) => {
    const finish = (error?: Error) => { dispose();

    if (error) reject(error); else resolve(); };

    const timer = setTimeout(() => finish(new Error("Timed out preparing the conversation")), 30000);
    onCleanup(() => clearTimeout(timer));
    createEffect(() => {
      if (active() !== owner) finish(new Error("Conversation changed"));
      else if (error()) finish(new Error(error()));
      else if (ready()) finish();
    });
  }));
}

