import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js";
import type { NativeTransport, ProjectBranches } from "./nativeTransport";
import type { ChatMessage, ImageAttachment } from "../types";
import { ownDraftSubmission, releaseDraftSubmission, type DraftSubmissionHandle } from "./draftSubmission";

type Submission = { owner: NativeTransport; message: ChatMessage; status: string; durable: DraftSubmissionHandle; selection?: { listing: ProjectBranches; createNew: boolean } };

const [submissions, setSubmissions] = createSignal<Submission[]>([]);

export const chatSubmission = (owner?: NativeTransport) => submissions().find(submission => submission.owner === owner);

export const isChatSubmissionActive = (id: string) => submissions().some(submission => submission.durable.id === id);

export function preserveChatSelection(owner: NativeTransport, listing: ProjectBranches, createNew: boolean) {
  setSubmissions(current => current.map(item => item.owner === owner ? { ...item, selection: { listing, createNew } } : item));
}

export function updateChatPreparation(owner: NativeTransport, status: string) {
  setSubmissions(current => current.map(item => item.owner === owner ? { ...item, status } : item));
}

export async function trackChatSubmission<T>(owner: NativeTransport, text: string, images: ImageAttachment[], durable: DraftSubmissionHandle, work: () => Promise<T>) {
  const message: ChatMessage = { id: durable.id, role: "user", content: [{ type: "text", text }, ...images] };
  setSubmissions(current => [...current, { owner, message, durable, status: "Sending message…" }]);
  ownDraftSubmission(durable);

  try {
    const result = await work();

    if (result === false) await durable.reject("Message was not submitted");
    else await durable.accept();

    return result;
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason);

    if (durable.wasDispatched()) await durable.uncertain(error);
    else await durable.reject(error);
    throw reason;
  } finally {
    releaseDraftSubmission(durable, owner);
    releaseDraftSubmission(durable);
    setSubmissions(current => current.filter(item => item.message !== message));
  }
}

const preparations = new WeakMap<NativeTransport, () => Promise<string | undefined>>();

export function registeredWorktreePreparation(owner: NativeTransport, exclude?: () => Promise<string | undefined>) {
  const prepare = preparations.get(owner);

  return prepare !== exclude ? prepare?.() : undefined;
}

export function registerWorktreePreparation(owner: NativeTransport, prepare: () => Promise<string | undefined>) {
  preparations.set(owner, prepare);

  return () => { if (preparations.get(owner) === prepare) preparations.delete(owner); };
}

function waitForConnection(owner: NativeTransport, active: Accessor<NativeTransport>, ready: Accessor<boolean>, error: Accessor<string | undefined>) {
  return new Promise<void>((resolve, reject) => createRoot((dispose) => {
    const finish = (error?: Error) => { dispose();

    if (error) reject(error); else resolve(); };

    const timer = setTimeout(() => finish(new Error("Timed out connecting to the worktree")), 30000);
    onCleanup(() => clearTimeout(timer));
    createEffect(() => {
      if (active() !== owner) finish(new Error("Conversation changed"));
      else if (error()) finish(new Error(error()));
      else if (ready()) finish();
    });
  }));
}

export async function prepareChatWorktree(owner: NativeTransport, select: (path: string, host: string, onActivate: (destination: NativeTransport) => Promise<void>) => Promise<void>, active: Accessor<NativeTransport>, ready: Accessor<boolean>, error: Accessor<string | undefined>) {
  const path = await registeredWorktreePreparation(owner);

  if (active() !== owner) throw new Error("Conversation changed");

  if (!path) { updateChatPreparation(owner, "Sending message…");

  return owner; }

  let selected: NativeTransport | undefined;
  await select(path, owner.currentHostId(), async (destination) => {
    const current = chatSubmission(owner);

    if (current) {
      try { await current.durable.move(destination); }
      finally { ownDraftSubmission(current.durable, owner); }

      setSubmissions(submissions => submissions.map(item => item.durable.id === current.durable.id ? { ...item, owner: destination } : item));
    }

    selected = destination;
  });
  const destination = selected;

  if (!destination || active() !== destination) throw new Error("Conversation changed");
  await waitForConnection(destination, active, ready, error);
  owner.promptControls.copyTo(destination.promptControls);

  return destination;
}
