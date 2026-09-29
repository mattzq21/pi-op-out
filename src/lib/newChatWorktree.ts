import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js";
import type { NativeTransport, ProjectBranches } from "./nativeTransport";
import type { ChatMessage, ImageAttachment } from "../types";

type Submission = { owner: NativeTransport; message: ChatMessage; status: string; selection?: { listing: ProjectBranches; createNew: boolean } };
const [submission, setSubmission] = createSignal<Submission>();
export const chatSubmission = (owner?: NativeTransport) => submission()?.owner === owner ? submission() : undefined;
export function preserveChatSelection(owner: NativeTransport, listing: ProjectBranches, createNew: boolean) {
  setSubmission((current) => current?.owner === owner ? { ...current, selection: { listing, createNew } } : current);
}
export function acknowledgeChatSubmission(owner?: NativeTransport) {
  setSubmission((current) => current?.owner === owner ? undefined : current);
}
export function updateChatPreparation(owner: NativeTransport, status: string) {
  setSubmission((current) => current?.owner === owner ? { ...current, status } : current);
}
export async function trackChatSubmission<T>(owner: NativeTransport, text: string, images: ImageAttachment[], work: () => Promise<T>) {
  const message: ChatMessage = { id: crypto.randomUUID(), role: "user", content: [{ type: "text", text }, ...images] };
  setSubmission({ owner, message, status: "Preparing conversation…" });
  let awaitingMessage = false;
  try {
    const result = await work();
    awaitingMessage = result !== false && !text.trimStart().startsWith("/");
    return result;
  } finally {
    if (!awaitingMessage) setSubmission((current) => current?.message === message ? undefined : current);
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
    const finish = (error?: Error) => { dispose(); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(new Error("Timed out connecting to the worktree")), 30000);
    onCleanup(() => clearTimeout(timer));
    createEffect(() => {
      if (active() !== owner) finish(new Error("Conversation changed"));
      else if (error()) finish(new Error(error()));
      else if (ready()) finish();
    });
  }));
}

export async function prepareChatWorktree(owner: NativeTransport, select: (path: string, host: string, onActivate: (destination: NativeTransport) => void) => Promise<void>, active: Accessor<NativeTransport>, ready: Accessor<boolean>, error: Accessor<string | undefined>) {
  const path = await registeredWorktreePreparation(owner);
  if (active() !== owner) throw new Error("Conversation changed");
  if (!path) { updateChatPreparation(owner, "Sending message…"); return owner; }
  await select(path, owner.currentHostId(), (destination) => {
    setSubmission((current) => current?.owner === owner ? { ...current, owner: destination } : current);
  });
  const destination = active();
  await waitForConnection(destination, active, ready, error);
  return destination;
}
