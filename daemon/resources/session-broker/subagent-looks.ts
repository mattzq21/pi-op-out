import { randomInt } from "node:crypto";

export const LOOK_COUNT = 48;
const HUE_COUNT = 8;

const reserved = new Map<string, Set<number>>();

export function reserveLook(parentSessionId: string, saved: (number | undefined)[]) {
  const pending = reserved.get(parentSessionId) ?? new Set<number>();
  const taken = new Set([...saved.filter(look => look !== undefined), ...pending]);
  const hues = new Set([...taken].map(look => look % HUE_COUNT));
  const start = randomInt(LOOK_COUNT);
  const order = Array.from({ length: LOOK_COUNT }, (_, step) => (start + step) % LOOK_COUNT);
  const look = order.find(item => !hues.has(item % HUE_COUNT)) ?? order.find(item => !taken.has(item)) ?? start;
  pending.add(look); reserved.set(parentSessionId, pending);

  return look;
}

export function releaseLook(parentSessionId: string, look: number | undefined) {
  const pending = reserved.get(parentSessionId);

  if (look === undefined || !pending) return;
  pending.delete(look);
  if (!pending.size) reserved.delete(parentSessionId);
}
