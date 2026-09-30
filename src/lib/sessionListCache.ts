import { createEffect, createSignal } from "solid-js";
import type { SessionSummary } from "../types";
import { isMobile } from "./platform";

function cacheKey() {
  if (!isMobile) return undefined;
  try {
    const host = localStorage.getItem("piop-mobile-host");
    return host ? `piop-session-list:v1:${host}` : undefined;
  } catch { return undefined; }
}

function validSession(value: unknown): value is SessionSummary {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return ["id", "path", "name", "project", "cwd", "preview"].every(key => typeof session[key] === "string")
    && ["messageCount", "lastMessageAt", "apiCost"].every(key => typeof session[key] === "number" && Number.isFinite(session[key]));
}

function restore(key?: string): SessionSummary[] {
  if (!key) return [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(saved) ? saved.filter(validSession).map(session => ({ ...session, isRunning: false })) : [];
  } catch { return []; }
}

export function createCachedSessionList() {
  const key = cacheKey();
  const signal = createSignal<SessionSummary[]>(restore(key));
  let saved: string | undefined;
  createEffect(() => {
    const sessions = signal[0]();
    if (!key) return;
    try {
      const serialized = JSON.stringify(sessions.filter(session => !session.isDraft).map(session => ({ ...session, isRunning: false })));
      if (serialized === saved) return;
      localStorage.setItem(key, serialized);
      saved = serialized;
    } catch { }
  });
  return signal;
}
