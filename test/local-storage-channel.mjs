import { fileURLToPath } from 'node:url';
const localTranscriptWrites = () => require('../daemon/resources/piop-storage/transcript-writes.ts').localTranscriptWrites();
const storageOperation = name => require('../daemon/resources/piop-storage/storage-operations.ts').storageOperation(name);
const sessionReferenceRoot = () => require('../daemon/resources/piop-storage/transcript-file.ts').sessionReferenceRoot();

// Pi's storage channel for tests and fixtures that run Pi's code without the daemon: the daemon's storage operations
// run in the same process, on the storage that PIOP_TEST_STORAGE_ROOT, or else HOME and PIOP_STORAGE_DIRECTORY, name at each call.
export function call(name, payload) {
  const operation = storageOperation(name);
  if (operation.area === 'transcript') return localTranscriptWrites()[operation.name](payload);
  return operation.run(process.env.PIOP_TEST_STORAGE_ROOT || sessionReferenceRoot(), structuredClone(payload));
}

export const transcriptWrites = Object.fromEntries(['publish', 'append', 'selectBranch', 'copyGoal']
  .map(name => [name, request => localTranscriptWrites()[name](request)]));

// The test process is the daemon here, so it writes its storage itself.
export function claim() { return null; }
export function hasChannel() { return false; }

// For esbuild: Pi's code in the bundle uses this channel instead of the daemon's.
export function localStorageChannel() {
  const path = fileURLToPath(import.meta.url);
  return { name: 'local-storage-channel', setup(build) { build.onResolve({ filter: /(^|\/)storage-channel\.ts$/ }, () => ({ path })); } };
}
