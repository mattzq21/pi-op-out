const REJECTION_MARK = "piop-rejected:\n";

/** Pi refused the command, so it had no effect and can be safely retried. */
export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRejectedError";
  }
}

export function commandRejection(text: string): CommandRejectedError | undefined {
  return text.startsWith(REJECTION_MARK) ? new CommandRejectedError(text.slice(REJECTION_MARK.length)) : undefined;
}
