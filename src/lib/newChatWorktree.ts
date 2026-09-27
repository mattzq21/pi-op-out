import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js";
import type { NativeTransport } from "./nativeTransport";
import type { ChatMessage, ImageAttachment } from "../types";

type Submission = { owner: NativeTransport; message: ChatMessage; status: string };
const [submission, setSubmission] = createSignal<Submission>();
export const chatSubmission = (owner?: NativeTransport) => submission()?.owner === owner ? submission() : undefined;
export function updateChatPreparation(owner: NativeTransport, status: string) {
  setSubmission((current) => current?.owner === owner ? { ...current, status } : current);
}
export async function trackChatSubmission<T>(owner: NativeTransport, text: string, images: ImageAttachment[], work: () => Promise<T>) {
  const message: ChatMessage = { id: crypto.randomUUID(), role: "user", content: [{ type: "text", text }, ...images] };
  setSubmission({ owner, message, status: "Preparing conversation…" });
  try { return await work(); }
  finally { setSubmission((current) => current?.message === message ? undefined : current); }
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

export async function prepareChatWorktree(owner: NativeTransport, select: (path: string, host: string) => Promise<void>, active: Accessor<NativeTransport>, ready: Accessor<boolean>, error: Accessor<string | undefined>) {
  const path = await registeredWorktreePreparation(owner);
  if (active() !== owner) throw new Error("Conversation changed");
  if (!path) { updateChatPreparation(owner, "Sending message…"); return owner; }
  updateChatPreparation(owner, "Opening worktree…");
  await select(path, owner.currentHostId());
  const destination = active();
  setSubmission((current) => current?.owner === owner ? { ...current, owner: destination, status: "Connecting to worktree…" } : current);
  await waitForConnection(destination, active, ready, error);
  updateChatPreparation(destination, "Sending message…");
  return destination;
}
