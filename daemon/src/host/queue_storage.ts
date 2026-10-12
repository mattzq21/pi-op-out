import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import * as Registry from '../session_registry';
import { ensurePrivateDir } from '../private_fs';
import { transaction, type Database } from '../util/db';
import { lockPath, type FileLock } from '../util/flock';
import * as Publication from './reference_publication';

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Formats a session ID the way the uuid crate prints a parsed identity (lowercase, hyphenated). */
export function parseIdentity(id: string): string {
  let value = id.trim() === id ? id : '';
  if (value.startsWith('urn:uuid:')) value = value.slice(9);
  if (value.startsWith('{') && value.endsWith('}')) value = value.slice(1, -1);
  if (!UUID.test(value)) throw new Error('Invalid queued-input session identity');
  const hex = value.replaceAll('-', '').toLowerCase();
  if (value.includes('-') && value.length !== 36) throw new Error('Invalid queued-input session identity');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

/** Lock that keeps queued-input storage writes in order across processes. */
export async function temporaryLock(root: string): Promise<FileLock> {
  ensurePrivateDir(root);
  const path = join(root, 'queued-input.lock');
  const lock = await lockPath(path, { blocking: true, timeoutMs: 10_000, nofollow: true, regularFile: 'Invalid queued-input storage lock' });
  if (!lock) throw new Error('Queued-input storage is locked by another process; try again');
  return lock;
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
  origin: any = null;

  constructor(directory: string, sessionId: string) {
    this.path = join(directory, parseIdentity(sessionId) + '.json');
  }

  withOrigin(cwd: string, sessionPath: string | null | undefined): this {
    if (!isAbsolute(cwd)) throw new Error('Queued-input recovery requires an absolute working directory');
    this.origin = { cwd, sessionPath: sessionPath ?? null };
    return this;
  }

  root(): string { return dirname(dirname(this.path)); }
  id(): string { return basename(this.path, '.json'); }

  reserveId(): string {
    const db = Registry.open(this.root());
    try {
      const row: any = db.prepare('UPDATE queue_item_sequence SET last_id=last_id+1 WHERE id=1 AND last_id<9007199254740991 RETURNING last_id').get();
      if (!row) throw new Error('Query returned no rows');
      return String(row.last_id);
    } finally { db.close(); }
  }

  record(): any | null {
    const db = Registry.open(this.root());
    try {
      return transaction(db, 'DEFERRED', () => {
        const row: any = db.prepare('SELECT cwd, session_path FROM queue_origins WHERE session_id=?').get(this.id());
        if (!row) return null;
        const origin = { cwd: row.cwd, sessionPath: row.session_path ?? null };
        return { version: 1, origin, items: loadRows(db, this.id()) };
      });
    } finally { db.close(); }
  }

  load(): any[] {
    const saved = this.record();
    return saved ? recoverItems(saved) : [];
  }

  async recover(pending: any[]): Promise<any[]> {
    const snapshot = structuredClone(pending);
    const origin = structuredClone(this.origin);
    return inOrder(resolve(this.root()), async () => {
      const recovered = this.load();
      for (const item of snapshot) {
        validateItem(item);
        item.retry = true;
        if (!recovered.some(saved => saved.id === item.id)) recovered.push(item);
      }
      await this.saveLocked(recovered, origin);
      return recovered;
    });
  }

  async save(items: any[]): Promise<void> {
    validateItems(items);
    const snapshot = structuredClone(items);
    const origin = structuredClone(this.origin);
    return inOrder(resolve(this.root()), () => this.saveLocked(snapshot, origin));
  }

  private async saveLocked(items: any[], origin: any): Promise<void> {
    const root = this.root();
    const publication = await Publication.lock(root);
    try {
      const storage = await temporaryLock(root);
      try {
        await Publication.validateNewReferences(root, items, this.load());
        const db = Registry.open(root);
        try { transaction(db, 'IMMEDIATE', () => this.writeItems(db, items, origin)); } finally { db.close(); }
      } finally { storage.release(); }
    } finally { publication.release(); }
  }

  private writeItems(db: Database, items: any[], origin: any): void {
    const id = this.id();
    if (!items.length) {
      db.prepare('DELETE FROM queue_items WHERE session_id=?').run(id);
      db.prepare('DELETE FROM queue_origins WHERE session_id=?').run(id);
      return;
    }
    if (!origin) throw new Error('Queued-input recovery is missing its working directory');
    db.prepare('INSERT INTO queue_origins VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, session_path=excluded.session_path')
      .run(id, typeof origin.cwd === 'string' ? origin.cwd : null, typeof origin.sessionPath === 'string' ? origin.sessionPath : null);
    saveRows(db, id, items);
  }
}

export async function clearSaved(root: string, id: string): Promise<void> {
  await new QueueStorage(join(root, 'queued-input'), id).save([]);
}

function recoverItems(saved: any): any[] {
  if (saved.version !== 1) throw new Error('Unsupported queued-input journal version');
  if (!Array.isArray(saved.items)) throw new Error('Invalid queued-input journal');
  const items = structuredClone(saved.items);
  const identities = new Set<string>();
  for (const item of items) {
    validateItem(item);
    const key = JSON.stringify(item.id);
    if (identities.has(key)) throw new Error('Duplicate queued-input journal identity');
    identities.add(key);
    item.retry = true;
  }
  return items;
}

function validateItems(items: any[]): void {
  if (items.length > 100) throw new Error('A session can have at most 100 queued items');
  for (const item of items) validateItem(item);
}

export function validateItem(item: any): void {
  itemId(item);
  if (typeof item.message !== 'string' || (item.behavior !== 'steer' && item.behavior !== 'followUp')) throw new Error('Invalid queued-input journal item');
  if (item.images !== undefined) {
    if (!Array.isArray(item.images)) throw new Error('Invalid queued-input journal attachments');
    if (item.images.some((image: any) => typeof image?.data !== 'string' || typeof image?.mimeType !== 'string')) throw new Error('Invalid queued-input journal attachment');
  }
}

export function itemId(item: any): number {
  const id = typeof item?.id === 'string' && /^[+]?\d+$/.test(item.id) ? Number(item.id) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid queue item ID');
  return id;
}

function loadRows(db: Database, session: string): any[] {
  const rows: any[] = db.prepare('SELECT queue_item_id, message, behavior, details_json FROM queue_items WHERE session_id=? ORDER BY queue_position').all(session);
  return rows.map(row => {
    const item = JSON.parse(row.details_json);
    item.id = String(row.queue_item_id);
    item.message = row.message;
    item.behavior = row.behavior;
    const images = loadImages(db, row.queue_item_id);
    if (images.length) item.images = images;
    return item;
  });
}

function loadImages(db: Database, id: number): any[] {
  const rows: any[] = db.prepare('SELECT media_type, data, details_json FROM queue_attachments WHERE queue_item_id=? ORDER BY attachment_position').all(id);
  return rows.map(row => {
    const image = JSON.parse(row.details_json);
    image.mimeType = row.media_type;
    image.data = Buffer.from(row.data).toString('base64');
    return image;
  });
}

function details(item: any, omitted: string[]): string {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid queue item');
  const fields = { ...item };
  for (const key of omitted) delete fields[key];
  return JSON.stringify(fields);
}

function saveRows(db: Database, session: string, items: any[]): void {
  const ids = items.map(itemId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate queue item ID');
  db.prepare('DELETE FROM queue_items WHERE session_id=? AND queue_item_id NOT IN (SELECT value FROM json_each(?))').run(session, JSON.stringify(ids));
  items.forEach((item, index) => saveItem(db, session, index + 1, item));
}

function saveItem(db: Database, session: string, position: number, item: any): void {
  const id = itemId(item);
  const written = db.prepare('INSERT INTO queue_items VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(queue_item_id) DO UPDATE SET queue_position=excluded.queue_position, message=excluded.message, behavior=excluded.behavior, details_json=excluded.details_json WHERE queue_items.session_id=excluded.session_id')
    .run(id, session, position, item.message, item.behavior, details(item, ['id', 'message', 'behavior', 'images']));
  if (Number(written.changes) !== 1) throw new Error('Queue item belongs to another session');
  const images: any[] = Array.isArray(item.images) ? item.images : [];
  db.prepare('DELETE FROM queue_attachments WHERE queue_item_id=? AND attachment_position>?').run(id, images.length);
  images.forEach((image, index) => {
    if (typeof image?.data !== 'string') throw new Error('Missing queue attachment data');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0) throw new Error('Invalid queue attachment encoding');
    db.prepare('INSERT INTO queue_attachments (queue_item_id, attachment_position, media_type, data, details_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(queue_item_id, attachment_position) DO UPDATE SET media_type=excluded.media_type, data=excluded.data, details_json=excluded.details_json')
      .run(id, index + 1, typeof image.mimeType === 'string' ? image.mimeType : null, Buffer.from(image.data, 'base64'), details(image, ['data', 'mimeType']));
  });
}
