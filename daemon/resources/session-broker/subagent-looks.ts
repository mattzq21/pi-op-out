import { randomInt } from "node:crypto";

/** Looks a subagent icon can have. The client maps a look number to a color (number % HUE_COUNT) and a shape. */
export const LOOK_COUNT = 48;
const HUE_COUNT = 8;

/** Looks given out per parent session and not yet saved with a run, so subagents that start at the same time do not share a look. */
const reserved = new Map<string, Set<number>>();

/** Picks a look for a new subagent of a parent session: a new color when one is free, else a look no sibling has. */
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

/** Ends the reservation once the run that has the look is saved, or was not created. */
export function releaseLook(parentSessionId: string, look: number | undefined) {
  const pending = reserved.get(parentSessionId);

  if (look === undefined || !pending) return;
  pending.delete(look);
  if (!pending.size) reserved.delete(parentSessionId);
}
