export function key(sessionId: string): string;
export function readRecord(root: string, key: string): string | null;
export function writeRecord(root: string, key: string, body: string): void;
export function removeRecord(root: string, key: string): void;
