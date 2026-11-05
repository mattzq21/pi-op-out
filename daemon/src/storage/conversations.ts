import { conversationOwnership as Storage } from '../../resources/chat-storage/index.ts';

export function read(root: string, key: string): string | undefined { return Storage.readRecord(root, key) ?? undefined; }

export function write(root: string, key: string, body: string): void { Storage.writeRecord(root, key, body); }

export function remove(root: string, key: string): void { Storage.removeRecord(root, key); }

export function key(sessionId: string): string { return Storage.key(sessionId); }
