const HUES = [0, 40, 95, 160, 200, 235, 280, 320];
const PETALS = [3, 4, 6];
const ROUNDNESS = [0.2, 0.5];
const LOOK_COUNT = HUES.length * PETALS.length * ROUNDNESS.length;

export interface SubagentLook { color: string; petals: number; roundness: number; turn: number }

function seedHash(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 2147483647;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function subagentLook(seed: string, saved?: number): SubagentLook {
  const look = saved ?? seedHash(seed) % LOOK_COUNT;
  const shape = Math.floor(look / HUES.length);
  return { color: `hsl(${HUES[look % HUES.length]} 75% 62%)`, petals: PETALS[shape % PETALS.length]!, roundness: ROUNDNESS[Math.floor(shape / PETALS.length)]!, turn: (seedHash(seed) >>> 16) % 45 };
}
