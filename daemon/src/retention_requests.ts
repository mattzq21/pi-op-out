// Who collects deferred cleanup for each storage root, so that code that changes the storage can ask for a pass.
const collectors = new Map<string, () => void>();

// Asks for a retention pass: the storage changed, so deferred cleanup may be possible now.
export function requestRetention(root: string): void { collectors.get(root)?.(); }

// Sets the collector of a storage root. Gives the function that removes it.
export function collectRetentionWith(root: string, collect: () => void): () => void {
  collectors.set(root, collect);
  return () => { if (collectors.get(root) === collect) collectors.delete(root); };
}
