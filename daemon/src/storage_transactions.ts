import storageTransactionBundle from '../resources/storage-transaction.bundle.mjs?raw';
import type { Host } from './host_connection';
import { runHostScript } from './host_script';

export interface ArchivedSession { sessionId: string; sourcePath: string; sessionPath: string }
export interface RestoredSession extends ArchivedSession { path: string }
export interface RestoreResult { path: string; sessionPath: string; sessionId: string; sessions: RestoredSession[] }
export interface DeletionTarget { path: string; area: 'sessions' | 'archived' }

export class StorageTransactionError extends Error {
  constructor(public readonly state: 'rolled-back' | 'pending', message: string) {
    super(message);
    this.name = 'StorageTransactionError';
  }
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

async function run(host: Host, request: Request, options: { signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<unknown> {
  const output = await runHostScript(host, storageTransactionBundle, [JSON.stringify(request)], { maxOutputBytes: 64 * 1024 * 1024, signal: options.signal });
  const diagnostic = output.stderr.toString().trim();
  if (output.status.code === 75 && request.action === 'recover' && options.busyIsOk) return;
  let response: unknown;
  try { response = JSON.parse(output.stdout.toString()); }
  catch { throw new Error(`Storage transaction outcome is unknown: ${diagnostic || 'missing or invalid response'}`); }
  if (!record(response) || !['committed', 'rolled-back', 'pending', 'skipped'].includes(String(response.state))
      || (response.warning !== undefined && !text(response.warning)) || (response.error !== undefined && !text(response.error))) {
    throw new Error('Invalid storage transaction response; outcome is unknown');
  }
  if (diagnostic) console.error(diagnostic);
  if (response.state === 'rolled-back' || response.state === 'pending') {
    if (response.warning) console.error(response.warning);
    throw new StorageTransactionError(response.state, text(response.error) ? response.error : diagnostic || `Storage transaction ${response.state}`);
  }
  if (!output.status.success) throw new Error(`Storage transaction outcome is unknown: ${diagnostic || `exit ${output.status.code}`}`);
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
  let value = await run(host, { action: 'result', path });
  if (record(value) && value.sessions === undefined && text(value.path) && text(value.sessionPath) && text(value.sessionId)) {
    value = { ...value, sessions: [{ path: value.path, sessionPath: value.sessionPath, sessionId: value.sessionId, sourcePath: path }] };
  }
  return checked(value, (value): value is RestoreResult | null => value === null || restoreResult(value));
}

export async function recover(host: Host, options: { root?: string; signal?: AbortSignal; busyIsOk?: boolean } = {}): Promise<void> {
  await run(host, { action: 'recover', root: options.root }, options);
}
