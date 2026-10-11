import type { Host } from './host_connection';
import { hostScript, HostScriptError, runHostScript } from './host_script';

export interface ArchivedSession { sessionId: string; sourcePath: string; sessionPath: string }
export interface RestoredSession extends ArchivedSession { path: string }
export interface RestoreResult { path: string; sessionPath: string; sessionId: string; sessions: RestoredSession[] }
export interface DeletionTarget { path: string; area: 'sessions' | 'archived' }

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
  return error instanceof Error ? error.message : String(error);
}

type Request =
  | { action: 'archive' | 'restore'; paths: string[] }
  | { action: 'delete'; targets: DeletionTarget[]; activeSessionIds: string[] }
  | { action: 'delete'; blank: { path?: string | null; id?: string | null } }
  | { action: 'result'; path: string }
  | { action: 'recover'; root?: string };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const archivedSession = (value: unknown): value is ArchivedSession => record(value) && text(value.sessionId) && text(value.sourcePath) && text(value.sessionPath);
const restoredSession = (value: unknown): value is RestoredSession => archivedSession(value) && record(value) && text(value.path);
const restoreResult = (value: unknown): value is RestoreResult => record(value) && text(value.path) && text(value.sessionPath) && text(value.sessionId)
  && Array.isArray(value.sessions) && value.sessions.length > 0 && value.sessions.every(restoredSession);

type Outcome = { state: 'committed'; result?: unknown; warning?: string } | { state: 'skipped'; reason?: string; warning?: string };

const storageTransaction = hostScript<Request, Outcome>('storage-transaction', 64 * 1024 * 1024, value => {
  if (!record(value) || !['committed', 'skipped'].includes(String(value.state)) || (value.warning !== undefined && !text(value.warning))) throw new Error('unexpected outcome');
  return value as Outcome;
});

function failure(error: unknown): StorageTransactionError {
  if (!(error instanceof HostScriptError)) return new StorageTransactionError('unknown', error instanceof Error ? error.message : String(error));
  if (error.warning) console.error(error.warning);
  if (error.kind === 'not-started') return new StorageTransactionError('rolled-back', error.message);
  if (error.kind === 'failed' && (error.state === 'rolled-back' || error.state === 'pending')) return new StorageTransactionError(error.state, error.message);
  return new StorageTransactionError('unknown', error.message);
}

async function run(host: Host, request: Request, options: { signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<unknown> {
  let response: Outcome;
  try { response = await runHostScript(host, storageTransaction, request, { signal: options.signal }); }
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

export async function archive(host: Host, paths: string[]): Promise<{ sessions: ArchivedSession[] }> {
  return checked(await run(host, { action: 'archive', paths }), (value): value is { sessions: ArchivedSession[] } =>
    record(value) && Array.isArray(value.sessions) && value.sessions.length > 0 && value.sessions.every(archivedSession));
}

export async function deleteSessions(host: Host, targets: DeletionTarget[], activeSessionIds: string[]): Promise<{ sessionIds: string[] }> {
  return checked(await run(host, { action: 'delete', targets, activeSessionIds }), (value): value is { sessionIds: string[] } =>
    record(value) && Array.isArray(value.sessionIds) && value.sessionIds.every(text));
}

export async function deleteBlank(host: Host, blank: { path?: string | null; id?: string | null }): Promise<void> {
  await run(host, { action: 'delete', blank });
}

export async function restore(host: Host, paths: string[]): Promise<RestoreResult> {
  return checked(await run(host, { action: 'restore', paths }), restoreResult);
}

export async function committedRestore(host: Host, path: string): Promise<RestoreResult | null> {
  return checked(await run(host, { action: 'result', path }), (value): value is RestoreResult | null => value === null || restoreResult(value));
}

export async function recover(host: Host, options: { root?: string; signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<void> {
  await run(host, { action: 'recover', root: options.root }, options);
}
