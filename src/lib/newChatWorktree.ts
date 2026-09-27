import { createEffect, createRoot, onCleanup, type Accessor } from "solid-js";
import type { NativeTransport } from "./nativeTransport";

const preparations = new WeakMap<NativeTransport, () => Promise<string | undefined>>();

export function registeredWorktreePreparation(owner: NativeTransport, exclude?: () => Promise<string | undefined>) {
  const prepare = preparations.get(owner);
  return prepare !== exclude ? prepare?.() : undefined;
}

export function registerWorktreePreparation(owner: NativeTransport, prepare: () => Promise<string | undefined>) {
  preparations.set(owner, prepare);
  return () => { if (preparations.get(owner) === prepare) preparations.delete(owner); };
}

function waitForConnection(owner: NativeTransport, active: Accessor<NativeTransport>, ready: Accessor<boolean>) {
  return new Promise<void>((resolve, reject) => createRoot((dispose) => {
    const finish = (error?: Error) => { dispose(); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(new Error("Timed out connecting to the worktree")), 30000);
    onCleanup(() => clearTimeout(timer));
    createEffect(() => {
      if (active() !== owner) finish(new Error("Conversation changed"));
      else if (ready()) finish();
    });
  }));
}

export async function prepareChatWorktree(owner: NativeTransport, select: (path: string, host: string) => Promise<void>, active: Accessor<NativeTransport>, ready: Accessor<boolean>) {
  const path = await registeredWorktreePreparation(owner);
  if (active() !== owner) throw new Error("Conversation changed");
  if (!path) return owner;
  await select(path, owner.currentHostId());
  const destination = active();
  await waitForConnection(destination, active, ready);
  return destination;
}
