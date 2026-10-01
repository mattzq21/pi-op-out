import type { Accessor } from "solid-js";
import type { NativeConnectionTarget } from "./nativeTransport";
import { isMobile } from "./platform";
import { createDependencyEffect } from "./solid";
import { z } from "zod";

export const nativeConnectionTargetSchema = z.object({
  cwd: z.string().optional(), sessionPath: z.string().optional(), sessionId: z.string().optional(),
  hostId: z.string().optional(), readOnly: z.boolean().optional(),
});

const savedSessionTargetSchema = nativeConnectionTargetSchema.omit({ readOnly: true }).required();

function storageKey() {
  const host = isMobile ? localStorage.getItem("piop-mobile-host") ?? "" : "desktop";
  const windowTarget = new URLSearchParams(window.location.search).get("target") ?? "main";

  return `piop-last-session:${host}:${windowTarget}`;
}

export function restoredSessionTarget(): NativeConnectionTarget {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) ?? "null");

    return savedSessionTargetSchema.parse(value);
  } catch { return {}; }
}

export function useSessionResume(selection: Accessor<{ target: NativeConnectionTarget; ready: boolean; saved: boolean; ephemeral: boolean }>) {
  let key: string | undefined;

  try { key = storageKey(); } catch { }

  createDependencyEffect(() => {
    const current = selection();

    if (!key || !current.ready || current.ephemeral) return;

    try {
      if (current.saved && current.target.sessionId && current.target.sessionPath) localStorage.setItem(key, JSON.stringify(current.target));
      else localStorage.removeItem(key);
    } catch { }
  }, () => [selection()]);
}
