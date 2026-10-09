import { cachedMobileHost } from "./mobileHosts";
import { createEffect, createSignal } from "solid-js";
import type { SessionSummary } from "../types";
import { isMobile } from "./platform";
import { z } from "zod";

const sessionSchema = z.looseObject({
  id: z.string(), path: z.string(), name: z.string(), project: z.string(), cwd: z.string(), preview: z.string(),
  messageCount: z.number(), lastMessageAt: z.number(), apiCost: z.number(),
});

function cacheKey() {
  if (!isMobile) return undefined;

  const host = cachedMobileHost();

  return host ? `piop-session-list:v1:${host}` : undefined;
}

function restore(key?: string): SessionSummary[] {
  if (!key) return [];

  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");

    if (!Array.isArray(saved)) return [];

    return saved.flatMap(value => {
      const session = sessionSchema.safeParse(value);

      return session.success ? [{ ...session.data, isRunning: false }] : [];
    });
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
