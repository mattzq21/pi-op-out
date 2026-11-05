import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js";
import type { NativeTransport } from "./nativeTransport";
import type { ChatMessage, ImageAttachment } from "../types";
import { ownDraftSubmission, releaseDraftSubmission, type DraftSubmissionHandle } from "./draftSubmission";
import { discardSubmittedMessage, retainSubmittedMessage } from "./sessionMemory";
import { CommandRejectedError } from "./commandRejected";
import { confirmSubmission } from "./submissionOutcome";

type Submission = { owner: NativeTransport; message: ChatMessage; status: string; durable: DraftSubmissionHandle };

const [submissions, setSubmissions] = createSignal<Submission[]>([]);

const tails = new WeakMap<NativeTransport, Promise<unknown>>();

export const chatSubmission = (owner?: NativeTransport) => submissions().find(submission => submission.owner === owner);

export const isChatSubmissionActive = (id: string) => submissions().some(submission => submission.durable.id === id);

export function updateChatPreparation(owner: NativeTransport, status: string) {
  setSubmissions(current => current.some(item => item.owner === owner && item.status !== status) ? current.map(item => item.owner === owner ? { ...item, status } : item) : current);
}

export async function trackChatSubmission<T>(owner: NativeTransport, text: string, images: ImageAttachment[], durable: DraftSubmissionHandle, work: () => Promise<T>, initialStatus = "Sending message…", behavior?: "steer" | "followUp") {
  const message: ChatMessage = { id: durable.id, role: "user", content: [{ type: "text", text }, ...images], deliveryBehavior: behavior };
  setSubmissions(current => [...current, { owner, message, durable, status: initialStatus }]);
  retainSubmittedMessage(owner, message);
  const previous = tails.get(owner);
  let settle!: () => void;
  const tail = new Promise<void>(resolve => { settle = resolve; });
  tails.set(owner, tail);
  let retain = false;

  try {
    await previous;
    ownDraftSubmission(durable);
    const result = await work();

    if (result === false) await durable.reject("Message was not submitted");
    else await durable.accept();
    retain = result !== false && !text.trimStart().startsWith("/");

    return result;
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason);

    if (!durable.wasDispatched() || reason instanceof CommandRejectedError) { await durable.reject(error); throw reason; }
    updateChatPreparation(owner, "Confirming the message…");
    const outcome = await confirmSubmission(durable.owner().currentHostId(), durable.id, failure => updateChatPreparation(owner, `Confirming the message… ${failure}`));

    if (!outcome?.accepted) { const refusal = outcome?.error ?? error; await durable.reject(refusal); throw new CommandRejectedError(refusal, "daemon"); }
    await durable.accept();
    retain = !text.trimStart().startsWith("/");

    return undefined as T;
  } finally {
    releaseDraftSubmission(durable, owner);
    releaseDraftSubmission(durable);

    if (!retain) {
      discardSubmittedMessage(owner, durable.id);
      discardSubmittedMessage(durable.owner(), durable.id);
    }

    setSubmissions(current => current.filter(item => item.message !== message));
    settle();

    if (tails.get(owner) === tail) tails.delete(owner);
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

