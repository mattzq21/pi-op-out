import type { Accessor } from "solid-js";
import type { NativeConnectionTarget } from "./nativeTransport";
import { isMobile } from "./platform";
import { createDependencyEffect } from "./solid";

function storageKey() {
  const host = isMobile ? localStorage.getItem("piop-mobile-host") ?? "" : "desktop";
  const windowTarget = new URLSearchParams(window.location.search).get("target") ?? "main";

  return `piop-last-session:${host}:${windowTarget}`;
}

export function restoredSessionTarget(): NativeConnectionTarget {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) ?? "null");

    if (!value || typeof value.sessionId !== "string" || typeof value.sessionPath !== "string" || typeof value.cwd !== "string" || typeof value.hostId !== "string") return {};

    return { sessionId: value.sessionId, sessionPath: value.sessionPath, cwd: value.cwd, hostId: value.hostId };
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
