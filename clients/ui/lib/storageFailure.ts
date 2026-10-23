import { commandRejection } from "./commandRejected";

export type StorageFailureState = "rolled-back" | "pending" | "unknown";
export type StorageAction = "archive" | "delete" | "restore";

const STATE_MARK = /^piop-storage-state:(rolled-back|pending|unknown)\n/;

export class StorageTransactionError extends Error {
  constructor(readonly state: StorageFailureState, message: string) {
    super(message);
    this.name = "StorageTransactionError";
  }
}

/** Turns a daemon error that carries a storage transaction state back into a typed error. Other errors pass through unchanged. */
export function daemonError(reason: unknown): unknown {
  const text = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : undefined;
  const rejected = text === undefined ? undefined : commandRejection(text);

  if (rejected) return rejected;
  const match = text === undefined ? null : STATE_MARK.exec(text);

  return match ? new StorageTransactionError(match[1] as StorageFailureState, text!.slice(match[0].length)) : reason;
}

const verbs: Record<StorageAction, { verb: string; noun: string }> = {
  archive: { verb: "archive", noun: "Archive" },
  delete: { verb: "delete", noun: "Deletion" },
  restore: { verb: "restore", noun: "Restore" },
};

export function storageFailure(action: StorageAction, reason: unknown, count = 1): { title: string; message: string } {
  const { verb, noun } = verbs[action];
  const what = count === 1 ? "conversation" : "conversations";
  const detail = reason instanceof Error ? reason.message : String(reason);

  if (!(reason instanceof StorageTransactionError)) return { title: `Could not ${verb} ${what}`, message: detail };

  if (reason.state === "rolled-back") return { title: `Could not ${verb} ${what}`, message: `Nothing was changed. ${detail}` };

  if (reason.state === "pending") return { title: `${noun} did not finish`, message: `Piop will finish or undo it before the next archive, delete or restore. ${detail}` };

  return { title: `${noun} result is unknown`, message: `Piop could not confirm what happened. Refresh to see the current state. ${detail}` };
}

export function storageFailureText(action: StorageAction, reason: unknown, count = 1) {
  const { title, message } = storageFailure(action, reason, count);

  return `${title}. ${message}`;
}
