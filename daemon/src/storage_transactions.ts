import { HostOperationError, hostOperation, runHostOperation, STORAGE_TIMEOUT } from './host_operations';
import { CommandRefusedError, refusalText } from './pi_rejection';

export interface ArchivedSession { sessionId: string; sourcePath: string; sessionPath: string }
export interface RestoredSession extends ArchivedSession { path: string }
export interface RestoreResult { path: string; sessionPath: string; sessionId: string; sessions: RestoredSession[] }
export interface DeletionTarget { path: string; area: 'sessions' | 'archived' }
/** A restored session whose working folder is from gets the folder to, written in the same transaction. */
export interface FolderMove { from: string; to: string }

export type StorageFailureState = 'rolled-back' | 'pending' | 'unknown';

/** Daemon replies carry errors as text, so the state rides on a first line that the client reads back. */
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

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const archivedSession = (value: unknown): value is ArchivedSession => record(value) && text(value.sessionId) && text(value.sourcePath) && text(value.sessionPath);
const restoredSession = (value: unknown): value is RestoredSession => archivedSession(value) && record(value) && text(value.path);
const restoreResult = (value: unknown): value is RestoreResult => record(value) && text(value.path) && text(value.sessionPath) && text(value.sessionId)
  && Array.isArray(value.sessions) && value.sessions.length > 0 && value.sessions.every(restoredSession);

type Outcome = { state: 'committed'; result?: unknown; warning?: string } | { state: 'skipped'; reason?: string; warning?: string };

const storageTransaction = hostOperation<Request, Outcome>('storage-transaction', 'storage', STORAGE_TIMEOUT, value => {
  if (!record(value) || !['committed', 'skipped'].includes(String(value.state)) || (value.warning !== undefined && !text(value.warning))) throw new Error('unexpected outcome');
  return value as Outcome;
});

function failure(error: unknown): StorageTransactionError {
  if (!(error instanceof HostOperationError)) return new StorageTransactionError('unknown', error instanceof Error ? error.message : String(error));
  if (error.warning) console.error(error.warning);
  if (error.kind === 'not-started') return new StorageTransactionError('rolled-back', error.message);
  if (error.kind === 'failed' && (error.state === 'rolled-back' || error.state === 'pending')) return new StorageTransactionError(error.state, error.message);
  return new StorageTransactionError('unknown', error.message);
}

/** Runs the transaction in the storage at root, or in the Piop profile of this machine. */
async function run(request: Request, options: { root?: string; signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<unknown> {
  let response: Outcome;
  try { response = await runHostOperation(storageTransaction, request, { signal: options.signal, storageRoot: options.root }); }
  catch (error) { throw failure(error); }
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

function checked<T>(value: unknown, valid: (value: unknown) => value is T): T {
  if (!valid(value)) throw new Error('Storage transaction committed, but its result is invalid');
  return value;
}

export async function archive(paths: string[]): Promise<{ sessions: ArchivedSession[] }> {
  return checked(await run({ action: 'archive', paths }), (value): value is { sessions: ArchivedSession[] } =>
    record(value) && Array.isArray(value.sessions) && value.sessions.length > 0 && value.sessions.every(archivedSession));
}

export async function deleteSessions(targets: DeletionTarget[], activeSessionIds: string[]): Promise<{ sessionIds: string[] }> {
  return checked(await run({ action: 'delete', targets, activeSessionIds }), (value): value is { sessionIds: string[] } =>
    record(value) && Array.isArray(value.sessionIds) && value.sessionIds.every(text));
}

export async function deleteBlank(blank: { path?: string | null; id?: string | null }): Promise<void> {
  await run({ action: 'delete', blank });
}

export async function restore(paths: string[], cwdMoves: FolderMove[] = []): Promise<RestoreResult> {
  return checked(await run({ action: 'restore', paths, cwdMoves }), restoreResult);
}

export async function committedRestore(path: string): Promise<RestoreResult | null> {
  return checked(await run({ action: 'result', path }), (value): value is RestoreResult | null => value === null || restoreResult(value));
}

export async function recover(options: { root?: string; signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<void> {
  await run({ action: 'recover' }, options);
}
