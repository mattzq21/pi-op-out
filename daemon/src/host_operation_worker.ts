import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { BUILD_ID } from './config';
import { QUEUED, STARTED, type HostOperationName, type WorkerJob, type WorkerReply } from './host_operation_protocol';

/** What a handler gets besides its request. begin() returns false when the caller already gave up; the handler must then stop without changes. */
interface Context { begin(): boolean; storage?: WorkerJob['storage'] }

const CANCELLED_RESULT = Symbol('cancelled');

type Handler = (input: any, context: Context) => Promise<unknown> | unknown;

/** Runs operation only when the caller still waits for it. */
function started(operation: (input: any) => Promise<unknown> | unknown): Handler {
  return (input, context) => context.begin() ? operation(input) : CANCELLED_RESULT;
}

const handlers: Record<HostOperationName, Handler> = {
  'chat-branch-history': started(async input => (await import('./chat_branch_history')).publishBranchHistory(input)),
  'discard-chat-branch': started(async input => (await import('./chat_branch_history')).discardBranchHistory(input.root, input.sessionId, input.sessionPath)),
  'session-descendants': started(async input => (await import('../resources/session-descendants.cjs')).sessionDescendants(input)),
  'index-sessions': started(async input => (await import('../resources/index-sessions.cjs')).indexSessions(input)),
  'storage-inventory': started(async input => (await import('../resources/storage-inventory.cjs')).storageInventory(input)),
  'recover-missing-session': started(async input => (await import('../resources/recover-missing-session.cjs')).recoverMissingSession(input)),
  'relocate-session': started(async input => (await import('../resources/relocate-session.cjs')).checkedRelocation(input)),
  'record-session-directory': started(async input => (await import('../resources/session-registry.cjs')).recordDirectory(input)),
  'temporary-chat': started(async input => (await import('../resources/temporary-chat.cjs')).temporaryChat(input)),
  'goal-text': started(async input => (await import('../resources/piop-storage/goal-dependencies.cjs')).textContents(input.root, input.directory).map((entry: any) => entry.text)),
  'agent-definitions': started(async input => (await import('piop-agent-loader')).loadAgentDefinitions(input)),
  'storage-transaction': async (input, context) => {
    if (!context.storage) throw new Error('Storage transaction has no storage locks');
    const { runStorageTransaction } = await import('../resources/storage-operation.cjs');
    const outcome = await runStorageTransaction({ ...context.storage, begin: context.begin }, input);
    return outcome?.state === 'cancelled' ? CANCELLED_RESULT : outcome;
  },
};

function failure(id: number, error: any): WorkerReply {
  const reply: WorkerReply = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  if (typeof error?.state === 'string') reply.state = error.state;
  if (typeof error?.warning === 'string') reply.warning = error.warning;
  return reply;
}

async function run(port: MessagePort, job: WorkerJob): Promise<void> {
  const progress = new Int32Array(job.progress);
  const begin = () => Atomics.compareExchange(progress, 0, QUEUED, STARTED) === QUEUED;
  let reply: WorkerReply;
  try {
    const handler = Object.hasOwn(handlers, job.name) ? handlers[job.name] : undefined;
    if (!handler) throw new Error('Unknown host operation: ' + job.name);
    const result = await handler(job.input, { begin, storage: job.storage });
    reply = result === CANCELLED_RESULT ? { id: job.id, ok: true, result: null, cancelled: true } : { id: job.id, ok: true, result: result ?? null };
  } catch (error) { reply = failure(job.id, error); }
  try { port.postMessage(reply); }
  catch (error) { port.postMessage(failure(job.id, new Error('Could not send the result: ' + (error instanceof Error ? error.message : String(error))))); }
}

/** True in a worker thread that the daemon started for host operations. */
export function isHostOperationWorker(): boolean {
  return !isMainThread && typeof workerData?.piopHostOperations === 'string';
}

/** Runs the jobs the daemon sends, one at a time per worker. */
export function runHostOperationWorker(): void {
  const port = parentPort!;
  if (workerData.piopHostOperations !== BUILD_ID) {
    port.postMessage({ fatal: 'The daemon executable changed after the daemon started; restart the daemon' } satisfies WorkerReply);
    return;
  }
  port.on('message', (job: WorkerJob) => { void run(port, job); });
}
