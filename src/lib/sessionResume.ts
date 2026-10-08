import type { Accessor } from "solid-js";
import type { NativeConnectionTarget } from "./nativeTransport";
import { isMobile } from "./platform";
import { createDependencyEffect } from "./solid";
import { z } from "zod";

export const nativeConnectionTargetSchema = z.object({
  cwd: z.string().optional(), sessionPath: z.string().optional(), sessionId: z.string().optional(),
  hostId: z.string().optional(), readOnly: z.boolean().optional(),
  draftKey: z.string().optional(),
});

const savedSessionTargetSchema = nativeConnectionTargetSchema.omit({ readOnly: true, draftKey: true }).required();

const draftTargetSchema = nativeConnectionTargetSchema.pick({ cwd: true, hostId: true, draftKey: true }).required({ hostId: true, draftKey: true });

const restoredTargetSchema = z.union([savedSessionTargetSchema, draftTargetSchema]);

function storageKey() {
  const host = isMobile ? localStorage.getItem("piop-mobile-host") ?? "" : "desktop";
  const windowTarget = new URLSearchParams(window.location.search).get("target");

  if (windowTarget) {
    localStorage.removeItem(`piop-last-session:${host}:${windowTarget}`);

    return;
  }

  return `piop-last-session:${host}:main`;
}

export function restoredSessionTarget(fallback: NativeConnectionTarget = {}): NativeConnectionTarget {
  try {
    const key = storageKey();

    if (!key) return {};
    const value = JSON.parse(localStorage.getItem(key) ?? "null");

    return restoredTargetSchema.parse(value);
  } catch { return fallback; }
}

export function targetedWindowSession(target: string): NativeConnectionTarget {
  const initial = nativeConnectionTargetSchema.parse(JSON.parse(target));

  if (initial.readOnly) return initial;

  try {
    const key = `piop-target-initialized:${target}`;
    const initialized = sessionStorage.getItem(key) === "1";
    sessionStorage.setItem(key, "1");

    return initialized ? restoredSessionTarget(initial) : initial;
  } catch { return initial; }
}

export function useSessionResume(selection: Accessor<{ target: NativeConnectionTarget; ready: boolean; saved: boolean; ephemeral: boolean }>) {
  let key: string | undefined;

  try { key = storageKey(); } catch { }

  createDependencyEffect(() => {
    const current = selection();

    if (!key || !current.ready || current.ephemeral) return;

    try {
      if (current.saved && current.target.sessionId && current.target.sessionPath) localStorage.setItem(key, JSON.stringify(current.target));
      else if (current.target.draftKey) localStorage.setItem(key, JSON.stringify(draftTargetSchema.parse(current.target)));
      else localStorage.removeItem(key);
    } catch { }
  }, () => [selection()]);
}
