import { z } from 'zod';
import { HostOperationError, hostOperation, profileRoot, runHostOperation, STORAGE_TIMEOUT } from '../host_operations';
import { requestRetention } from './retention_requests';
import { CommandRefusedError, refusalText } from '../pi_rejection';
import * as Registry from '../session_registry';

const archivedSessionSchema = z.object({ sessionId: z.string(), sourcePath: z.string(), sessionPath: z.string() });
const restoredSessionSchema = archivedSessionSchema.extend({ path: z.string() });
const restoreResultSchema = z.object({ path: z.string(), sessionPath: z.string(), sessionId: z.string(), sessions: z.array(restoredSessionSchema).min(1) });

export type ArchivedSession = z.output<typeof archivedSessionSchema>;
export type RestoredSession = z.output<typeof restoredSessionSchema>;
export type RestoreResult = z.output<typeof restoreResultSchema>;
export interface DeletionTarget { path: string; area: 'sessions' | 'archived' }
export interface FolderMove { from: string; to: string }

export type StorageFailureState = 'rolled-back' | 'pending' | 'unknown';

const STATE_MARK = 'piop-storage-state:';

export class StorageTransactionError extends Error {
  constructor(public readonly state: StorageFailureState, message: string) {
    super(message);
    this.name = 'StorageTransactionError';
  }
}

export function responseErrorText(error: unknown): string {
  if (error instanceof StorageTransactionError) return `${STATE_MARK}${error.state}\n${error.message}`;
  if (error instanceof CommandRefusedError) return refusalText(error.message, error.by);
  return error instanceof Error ? error.message : String(error);
}

type Request =
  | { action: 'archive'; paths: string[] }
  | { action: 'restore'; paths: string[]; cwdMoves?: FolderMove[] }
  | { action: 'delete'; targets: DeletionTarget[]; activeSessionIds: string[] }
  | { action: 'delete'; blank: { path?: string | null; id?: string | null } }
  | { action: 'result'; path: string }
  | { action: 'recover' };

type Outcome = { state: 'committed'; result?: unknown; warning?: string } | { state: 'skipped'; reason?: string; warning?: string };

const storageTransaction = hostOperation<Request, Outcome>('storage-transaction', 'storage', STORAGE_TIMEOUT, z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), result: z.unknown().optional(), warning: z.string().optional() }),
  z.object({ state: z.literal('skipped'), reason: z.string().optional(), warning: z.string().optional() }),
]));

function failure(error: unknown): StorageTransactionError {
  if (!(error instanceof HostOperationError)) return new StorageTransactionError('unknown', error instanceof Error ? error.message : String(error));
  if (error.warning) console.error(error.warning);
  if (error.kind === 'not-started') return new StorageTransactionError('rolled-back', error.message);
  if (error.kind === 'failed' && (error.state === 'rolled-back' || error.state === 'pending')) return new StorageTransactionError(error.state, error.message);
  return new StorageTransactionError('unknown', error.message);
}

async function run(request: Request, options: { root?: string; signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<unknown> {
  let response: Outcome;
  try { response = await runHostOperation(storageTransaction, request, { signal: options.signal, storageRoot: options.root }); }
  catch (error) { throw failure(error); }
  // A deletion of chats can free what deferred cleanup waits for: what only the deleted chats used.
  if (response.state === 'committed' && request.action === 'delete' && 'targets' in request) requestRetention(options.root ?? profileRoot());
  if (response.warning) console.error(response.warning);
  if (response.state === 'skipped') {
    if (request.action === 'delete' && 'blank' in request && ['busy', 'not-needed'].includes(String(response.reason))) return;
    if (request.action === 'recover' && response.reason === 'busy') {
      if (options.busyIsOk) return;
      throw new Error('Storage transaction lock is busy');
    }
    throw new Error('Unexpected skipped storage transaction');
  }
  return response.result;
}

function checked<T>(value: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Storage transaction committed, but its result is invalid: ' + z.prettifyError(parsed.error));
  return parsed.data;
}

export async function archive(paths: string[]): Promise<{ sessions: ArchivedSession[] }> {
  return checked(await run({ action: 'archive', paths }), z.object({ sessions: z.array(archivedSessionSchema).min(1) }));
}

export async function deleteSessions(targets: DeletionTarget[], activeSessionIds: string[]): Promise<{ sessionIds: string[] }> {
  return checked(await run({ action: 'delete', targets, activeSessionIds }), z.object({ sessionIds: z.array(z.string()) }));
}

export async function deleteBlank(blank: { path?: string | null; id?: string | null }): Promise<void> {
  await run({ action: 'delete', blank });
}

export async function restore(paths: string[], cwdMoves: FolderMove[] = []): Promise<RestoreResult> {
  return checked(await run({ action: 'restore', paths, cwdMoves }), restoreResultSchema);
}

export async function committedRestore(path: string): Promise<RestoreResult | null> {
  return checked(await run({ action: 'result', path }), restoreResultSchema.nullable());
}

export async function recover(options: { root?: string; signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<void> {
  await run({ action: 'recover' }, options);
}

export async function recoverPending(root: string): Promise<void> {
  if (!Registry.pending(root, 'recovery')) return;
  await recover({ root, busyIsOk: true });
}
