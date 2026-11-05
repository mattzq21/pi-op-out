export type { Connection as Database } from '../../resources/session-database.ts';

export { connection, transaction } from '../../resources/session-database.ts';

export function blob(value: unknown): Buffer | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value);
  return undefined;
}
