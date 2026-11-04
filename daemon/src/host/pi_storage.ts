import { OPERATIONS, PUBLICATION_LOCKED } from '../../resources/piop-storage/transcript-writes.mjs';
import { acquireReferencePublicationLockAsync } from '../../resources/piop-storage/reference-publication-lock.cjs';
import { errorText } from '../util/sync';

// Pi sends its storage changes here, on its storage channel, and waits for each answer. The daemon is then the only process that writes them.
// Answers one request line with one answer line.
export async function answerStorageRequest(root: string, line: string): Promise<string> {
  try {
    const request = JSON.parse(line);
    const [area, name] = typeof request?.operation === 'string' ? request.operation.split('.') : [];
    const operation = area === 'transcript' && Object.hasOwn(OPERATIONS, name) ? (OPERATIONS as Record<string, (root: string, request: unknown) => unknown>)[name] : undefined;
    if (!operation) throw new Error('Unknown storage request: ' + String(request?.operation));
    const release = PUBLICATION_LOCKED.has(name) ? await acquireReferencePublicationLockAsync(root) : undefined;
    try { return JSON.stringify({ result: operation(root, request.payload) ?? null }); }
    finally { release?.(); }
  } catch (error: any) {
    return JSON.stringify({ error: errorText(error), damaged: error?.damaged === true });
  }
}
