import { createContext, createMemo } from "solid-js";

/** Hues far enough apart to tell apart at 14px. */
const HUES = [0, 40, 95, 160, 200, 235, 280, 320];
const PETALS = [3, 4, 6];
/** Petal corner radius as a part of the petal size: square or round. */
const ROUNDNESS = [0.2, 0.5];
const LOOK_COUNT = HUES.length * PETALS.length * ROUNDNESS.length;

export interface SubagentLook { color: string; petals: number; roundness: number; turn: number }

/** The ChatGPT app's string hash, then a mix step so that similar seeds such as "Svg4" and "Svg5" land far apart. */
function seedHash(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 2147483647;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Hue changes first, so the next look after a taken one has a new color. */
const hueOf = (look: number) => look % HUES.length;

export function subagentLook(seed: string, look = seedHash(seed) % LOOK_COUNT): SubagentLook {
  const shape = Math.floor(look / HUES.length);
  return { color: `hsl(${HUES[hueOf(look)]} 75% 62%)`, petals: PETALS[shape % PETALS.length]!, roundness: ROUNDNESS[Math.floor(shape / PETALS.length)]!, turn: (seedHash(seed) >>> 16) % 45 };
}

/** Gives each subagent of one chat its own look, in the order the subagents first show. A look, once given, does not change while the chat is open. */
export function createSubagentLooks(seeds: () => string[], chat: () => string) {
  let given = new Map<string, number>();
  let owner = "";

  const looks = createMemo(() => {
    if (chat() !== owner) { owner = chat(); given = new Map(); }
    for (const seed of seeds()) {
      if (given.has(seed)) continue;
      const taken = new Set(given.values());
      const hues = new Set([...taken].map(hueOf));
      const start = seedHash(seed) % LOOK_COUNT;
      const order = Array.from({ length: LOOK_COUNT }, (_, step) => (start + step) % LOOK_COUNT);
      given.set(seed, order.find(look => !hues.has(hueOf(look))) ?? order.find(look => !taken.has(look)) ?? start);
    }
    return given;
  }, undefined, { equals: false });

  return (seed: string) => looks().get(seed);
}

/** The look number given to a subagent seed in this chat, or undefined when the chat has not given one. */
export const SubagentLookContext = createContext<(seed: string) => number | undefined>();
