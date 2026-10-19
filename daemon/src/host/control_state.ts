export interface SavedControlState { isPaused: boolean }

export function reduce(entries: any[], leafId: string | undefined | null): SavedControlState {
  let isPaused = false;
  for (const entry of branch(entries, leafId)) {
    if (entry?.type !== 'custom') continue;
    const data = entry.data;
    if (entry.customType === 'pi-desktop-pause-state') isPaused = data?.isPaused === true;
  }
  return { isPaused };
}

function branch(entries: any[], leafId: string | undefined | null): any[] {
  const byId = new Map<string, any>();
  for (const entry of entries) if (entry?.type !== 'session' && typeof entry?.id === 'string') byId.set(entry.id, entry);
  const seen = new Set<string>();
  let cursor: unknown = leafId;
  const result: any[] = [];
  while (typeof cursor === 'string' && cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    result.push(entry);
    cursor = entry.parentId;
  }
  return result.reverse();
}
