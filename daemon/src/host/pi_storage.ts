import type { Duplex } from 'node:stream';
import { releaseClaims, storageOperation } from '../../resources/piop-storage/storage-operations.mjs';
import { acquireReferencePublicationLockAsync } from '../../resources/piop-storage/reference-publication-lock.cjs';
import { acquireAsync as acquireGoalAssets } from '../../resources/piop-storage/goal-assets.cjs';
import { withinFlow } from '../../resources/storage-locks.cjs';
import { readLines } from '../../resources/lf-lines.cjs';
import { errorText } from '../util/sync';

// The kinds of storage changes that a process may ask for. A Pi with a chat may make all of them.
export type StorageArea = 'transcript' | 'publication' | 'mailbox' | 'subagents' | 'records' | 'settings';
const ALL: readonly StorageArea[] = ['transcript', 'publication', 'mailbox', 'subagents', 'records', 'settings'];

// Pi sends its storage changes here, on its storage channel, and waits for each answer. The daemon is then the only process that writes them.
// One PiStorage serves one process. It keeps what that process holds, and gives it back when the channel closes.
export class PiStorage {
  readonly claims = new Set<string>();
  private areas: ReadonlySet<StorageArea>;

  constructor(readonly root: string, areas: readonly StorageArea[] = ALL) { this.areas = new Set(areas); }

  // Answers one request line with one answer line.
  async answer(line: string): Promise<string> {
    try {
      const request = JSON.parse(line);
      const operation = storageOperation(request?.operation);
      if (!this.areas.has(operation.area as StorageArea)) throw new Error('This process cannot ask for ' + request.operation);
      // One flow, so that the operation gets the goal asset lock taken here again at once.
      return await withinFlow(async () => {
        const release = operation.referenceLocked ? await acquireReferencePublicationLockAsync(this.root) : undefined;
        try {
          const assets = operation.goalAssetsLocked ? await acquireGoalAssets(this.root) : undefined;
          try { return JSON.stringify({ result: (await (operation.run as (root: string, request: unknown, owner: PiStorage) => unknown)(this.root, request.payload, this)) ?? null }); }
          finally { assets?.(); }
        } finally { release?.(); }
      });
    } catch (error: any) {
      return JSON.stringify({ error: errorText(error), damaged: error?.damaged === true, publicationPending: error?.publicationPending === true, dependenciesRetained: error?.dependenciesRetained === true });
    }
  }

  // Answers the requests on one process's storage channel, in order, until the channel closes.
  serve(channel: Duplex, diagnostic: (message: string) => void): void {
    let answered = Promise.resolve();
    channel.on('error', error => diagnostic('Storage channel failed: ' + error.message));
    readLines(channel, line => {
      answered = answered.then(async () => {
        const answer = await this.answer(line);
        if (!channel.writable) return;
        await new Promise<void>((resolve, reject) => channel.write(answer + '\n', error => error ? reject(error) : resolve()));
      }).catch(error => diagnostic('Could not answer a storage request: ' + error.message));
    }, () => {
      // The process is gone: what it still held goes back once its last request is answered.
      answered = answered.then(() => releaseClaims(this.root, this)).catch(error => diagnostic('Could not release the storage of a stopped process: ' + error.message));
    });
  }
}
