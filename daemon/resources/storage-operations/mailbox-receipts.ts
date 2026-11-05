import * as database from '../session-database/index.ts';

// The delivery IDs of the agent mail that the transcript of a chat holds. The transcript writes keep it,
// inside their own transactions.

interface ReceiptEntry { type?: string; details?: any; message?: { details?: any } }

function details(entry: ReceiptEntry | undefined): any {
  if (entry?.type === 'custom_message') return entry.details;

  return entry?.type === 'message' ? entry.message?.details : undefined;
}

function receipt(entry: ReceiptEntry, sessionId: string): string | undefined {
  const value = details(entry);

  if (value?.mailboxSessionId === sessionId && typeof value.notificationId === 'string') return value.notificationId;
}

// After entry was added to the transcript of sessionId.
function add(root: string, sessionId: string, entry: ReceiptEntry): void {
  const saved = receipt(entry, sessionId);

  if (saved) database.addMailboxReceipt(root, sessionId, saved);
}

// After the transcript of sessionId was saved again with entries.
function replace(root: string, sessionId: string, entries: ReceiptEntry[]): void {
  database.replaceMailboxReceipts(root, sessionId, entries.flatMap(entry => receipt(entry, sessionId) ?? []));
}

function list(root: string, sessionId: string): string[] {
  return database.mailboxReceipts(root, sessionId);
}

export { add, replace, list };
