import { z } from 'zod';
import * as Lifecycle from '../../resources/session-lifecycle.ts';
import { hostOperation, profileRoot, runHostOperation, STORAGE_TIMEOUT } from '../host_operations';

export interface SavedSession { sessionId: string; sessionPath: string; archived: boolean }

type Request =
  | { action: 'delete'; sessionIds: string[] }
  | { action: 'delete-blank'; blank: { path?: string | null; id?: string | null } };

const answerSchema = z.object({ warning: z.string().optional(), busy: z.boolean().optional() });

const operation = hostOperation<Request, z.output<typeof answerSchema>>('session-storage', 'storage', STORAGE_TIMEOUT, answerSchema);

async function run(request: Request, options: { root?: string; signal?: AbortSignal } = {}): Promise<boolean> {
  const answer = await runHostOperation(operation, request, { signal: options.signal, storageRoot: options.root });
  if (answer.warning) console.error(answer.warning);
  return answer.busy !== true;
}

// The saved chat id, or undefined when it has no saved transcript.
export function session(id: string, root = profileRoot()): SavedSession | undefined { return Lifecycle.session(root, id); }

export function idOf(path: string, root = profileRoot()): string | undefined { return Lifecycle.idOf(root, path); }

// The chats under id, parents first; filter limits them to some kinds or to one archive state.
export function descendants(id: string, filter: { archived?: boolean; kinds?: string[] } = {}, root = profileRoot()): SavedSession[] {
  return Lifecycle.descendants(root, id, filter);
}

export function archive(ids: string[], root = profileRoot()): void { Lifecycle.archive(root, ids); }

export function restore(ids: string[], root = profileRoot()): void { Lifecycle.restore(root, ids); }

// Deletes the chats ids: their rows at once, then their files.
export async function deleteSessions(ids: string[]): Promise<void> {
  await run({ action: 'delete', sessionIds: ids });
}

// Deletes a chat that has no message, unless the storage is busy.
export async function deleteBlank(blank: { path?: string | null; id?: string | null }): Promise<void> {
  await run({ action: 'delete-blank', blank });
}

// Removes the files of chats that were deleted while the daemon stopped. Gives the warnings.
export function sweep(root = profileRoot()): string[] { return Lifecycle.sweep(root); }
