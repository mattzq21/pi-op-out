export interface SavedControlState { isPaused: boolean }

export function reduce(entries: any[], _leafId: string | undefined | null): SavedControlState {
  const state = entries.findLast(entry => entry?.type === 'custom' && entry.customType === 'pi-desktop-pause-state');
  return { isPaused: state?.data?.isPaused === true };
}
