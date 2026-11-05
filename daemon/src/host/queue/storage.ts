import { join, dirname, basename, resolve } from 'node:path';
import { clearQueue, isQueueHeld, nextQueueItemId, savedQueue, setQueueHeld, transaction, writeQueue, type QueueRow } from '../../../resources/session-database.ts';

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function parseIdentity(id: string): string {
  let value = id.trim() === id ? id : '';
  if (value.startsWith('urn:uuid:')) value = value.slice(9);
  if (value.startsWith('{') && value.endsWith('}')) value = value.slice(1, -1);
  if (!UUID.test(value)) throw new Error('Invalid queued-input session identity');
  const hex = value.replaceAll('-', '').toLowerCase();
  if (value.includes('-') && value.length !== 36) throw new Error('Invalid queued-input session identity');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

const saves = new Map<string, Promise<void>>();

function inOrder<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = saves.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => {}, () => {});
  saves.set(key, tail);
  void tail.then(() => { if (saves.get(key) === tail) saves.delete(key); });
  return result;
}

export async function drainSaves(root: string): Promise<void> {
  const key = resolve(root);
  while (saves.has(key)) await saves.get(key);
}

export class QueueStorage {
  readonly path: string;

  constructor(directory: string, sessionId: string) {
    this.path = join(directory, parseIdentity(sessionId) + '.json');
  }

  root(): string { return dirname(dirname(this.path)); }
  id(): string { return basename(this.path, '.json'); }

  reserveId(): string {
    return nextQueueItemId(this.root());
  }

  load(): any[] {
    return recoverItems(savedQueue(this.root(), this.id()));
  }

  held(): boolean {
    return isQueueHeld(this.root(), this.id());
  }

  async saveHeld(held: boolean): Promise<void> {
    const root = this.root();
    return inOrder(resolve(root), async () => setQueueHeld(root, this.id(), held));
  }

  async recover(pending: any[]): Promise<any[]> {
    const snapshot = structuredClone(pending);
    return inOrder(resolve(this.root()), async () => {
      const recovered = this.load();
      for (const item of snapshot) {
        validateItem(item);
        restartItem(item);
        if (!recovered.some(saved => saved.id === item.id)) recovered.push(item);
      }
      this.saveLocked(recovered);
      return recovered;
    });
  }

  async save(items: any[]): Promise<void> {
    validateItems(items);
    const snapshot = structuredClone(items);
    return inOrder(resolve(this.root()), async () => this.saveLocked(snapshot));
  }

  private saveLocked(items: any[]): void {
    const root = this.root();
    const id = this.id();
    transaction(root, 'IMMEDIATE', () => items.length ? writeQueue(root, id, queueRows(items)) : clearQueue(root, id));
  }
}

export async function clearSaved(root: string, id: string): Promise<void> {
  await new QueueStorage(join(root, 'queued-input'), id).save([]);
}

function restartItem(item: any): void {
  delete item.taken;
  delete item.held;
  delete item.used;
}

function recoverItems(items: any[]): any[] {
  for (const item of items) restartItem(item);
  return items;
}

function validateItems(items: any[]): void {
  if (items.length > 100) throw new Error('A session can have at most 100 queued items');
  for (const item of items) validateItem(item);
}

export function validateItem(item: any): void {
  itemId(item);
  if (typeof item.message !== 'string' || (item.behavior !== 'steer' && item.behavior !== 'followUp')) throw new Error('Invalid queued item');
  if (item.images !== undefined) {
    if (!Array.isArray(item.images)) throw new Error('Invalid queued item attachments');
    if (item.images.some((image: any) => typeof image?.data !== 'string' || typeof image?.mimeType !== 'string')) throw new Error('Invalid queued item attachment');
  }
}

export function itemId(item: any): number {
  const id = typeof item?.id === 'string' && /^[+]?\d+$/.test(item.id) ? Number(item.id) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid queue item ID');
  return id;
}

function details(item: any, omitted: string[]): string {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid queue item');
  const fields = { ...item };
  for (const key of omitted) delete fields[key];
  return JSON.stringify(fields);
}

function queueRows(items: any[]): QueueRow[] {
  const ids = items.map(itemId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate queue item ID');
  return items.map((item, index) => ({
    id: ids[index], message: item.message, behavior: item.behavior, details: details(item, ['id', 'message', 'behavior', 'images']),
    images: (Array.isArray(item.images) ? item.images : []).map((image: any) => {
      if (typeof image?.data !== 'string') throw new Error('Missing queue attachment data');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0) throw new Error('Invalid queue attachment encoding');
      return { mimeType: typeof image.mimeType === 'string' ? image.mimeType : null, data: Buffer.from(image.data, 'base64'), details: details(image, ['data', 'mimeType']) };
    }),
  }));
}
