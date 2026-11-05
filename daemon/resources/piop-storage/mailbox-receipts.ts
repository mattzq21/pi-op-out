import * as database from '../session-database.ts';

// The agent mail that the transcript of a chat holds: delivery ID and fingerprint pairs. The transcript writes keep it,
// inside their own transactions.

interface ReceiptEntry { type?: string; details?: any; message?: { details?: any } }

function details(entry: ReceiptEntry | undefined): any {
  if (entry?.type === 'custom_message') return entry.details;

  return entry?.type === 'message' ? entry.message?.details : undefined;
}

function receipt(entry: ReceiptEntry, sessionId: string): [string, string] | undefined {
  const value = details(entry);

  if (value?.mailboxSessionId !== sessionId || typeof value.notificationId !== 'string' || typeof value.mailboxFingerprint !== 'string') return;

  return [value.notificationId, value.mailboxFingerprint];
}

// After entry was added to the transcript of sessionId.
function add(root: string, sessionId: string, entry: ReceiptEntry): void {
  const saved = receipt(entry, sessionId);

  if (saved) database.addMailboxReceipt(root, sessionId, ...saved);
}

// After the transcript of sessionId was saved again with entries.
function replace(root: string, sessionId: string, entries: ReceiptEntry[]): void {
  database.replaceMailboxReceipts(root, sessionId, entries.flatMap((entry): [string, string][] => { const saved = receipt(entry, sessionId); return saved ? [saved] : []; }));
}

function list(root: string, sessionId: string): Array<[string, string]> {
  return database.mailboxReceipts(root, sessionId);
}

export { add, replace, list };
