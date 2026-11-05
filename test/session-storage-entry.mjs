// Session storage with its transcript writes run in the same process, for tests that stand in for the daemon.
export { installSessionStorage } from '../daemon/resources/piop-storage/session-storage.ts';
export { localTranscriptWrites } from '../daemon/resources/piop-storage/transcript-writes.ts';
