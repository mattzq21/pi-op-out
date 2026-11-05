import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { BUILD_ID } from '../environment';
import { connectWorker } from '../../resources/session-database/index.ts';
import { withinFlow } from '../storage';
import { QUEUED, STARTED, type HostOperationName, type WorkerJob, type WorkerReply } from './protocol';

interface Context { begin(): boolean; storage?: WorkerJob['storage'] }

const CANCELLED_RESULT = Symbol('cancelled');

type Handler = (input: any, context: Context) => Promise<unknown> | unknown;

function started(operation: (input: any) => Promise<unknown> | unknown): Handler {
  return (input, context) => context.begin() ? operation(input) : CANCELLED_RESULT;
}

const handlers: Record<HostOperationName, Handler> = {
  'chat-branch-history': started(async input => (await import('../storage')).publishBranchHistory(input)),
  'discard-chat-branch': started(async input => (await import('../storage')).discardBranchHistory(input.root, input.sessionId, input.sessionPath)),
  'index-sessions': started(async input => (await import('../storage')).indexSessions(input)),
  'storage-inventory': started(async input => (await import('../storage')).storageInventory(input)),
  'recover-missing-session': started(async input => (await import('../storage')).recoverMissingSession(input)),
  'relocate-session': started(async input => (await import('../storage')).checkedRelocation(input)),
  'temporary-chat': started(async input => (await import('../storage')).temporaryChat(input)),
  'agent-definitions': started(async input => (await import('piop-agent-loader')).loadAgentDefinitions(input)),
  'save-agent-definitions': started(async input => (await import('piop-agent-loader')).saveAgentDefinitions(input)),
  'move-agent': started(async input => (await import('piop-agent-loader')).moveAgent(input)),
  'session-storage': async (input, context) => {
    if (!context.storage) throw new Error('Session storage change has no storage root');
    const answer = (await import('../storage')).lifecycle.run({ root: context.storage.root, begin: context.begin }, input);
    return answer.cancelled ? CANCELLED_RESULT : answer;
  },
};

function failure(id: number, error: any): WorkerReply {
  return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function run(port: MessagePort, job: WorkerJob): Promise<void> {
  const progress = new Int32Array(job.progress);
  const begin = () => Atomics.compareExchange(progress, 0, QUEUED, STARTED) === QUEUED;
  let reply: WorkerReply;
  try {
    const handler = Object.hasOwn(handlers, job.name) ? handlers[job.name] : undefined;
    if (!handler) throw new Error('Unknown host operation: ' + job.name);
    const result = await withinFlow(() => handler(job.input, { begin, storage: job.storage }));
    reply = result === CANCELLED_RESULT ? { id: job.id, ok: true, result: null, cancelled: true } : { id: job.id, ok: true, result: result ?? null };
  } catch (error) { reply = failure(job.id, error); }
  try { port.postMessage(reply); }
  catch (error) { port.postMessage(failure(job.id, new Error('Could not send the result: ' + (error instanceof Error ? error.message : String(error))))); }
}

export function isHostOperationWorker(): boolean {
  return !isMainThread && typeof workerData?.piopHostOperations === 'string';
}

export function runHostOperationWorker(): void {
  const port = parentPort!;
  if (workerData.piopHostOperations !== BUILD_ID) {
    port.postMessage({ fatal: 'The daemon executable changed after the daemon started; restart the daemon' } satisfies WorkerReply);
    return;
  }
  connectWorker(workerData.mainThread.port, workerData.mainThread.signal);
  port.on('message', (job: WorkerJob) => { void run(port, job); });
}
