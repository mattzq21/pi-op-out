const REFUSAL_MARK = /^piop-refused:(pi|daemon)\n/;

/** A command was refused, so it had no effect and can be safely retried. Pi refused it, or the daemon refused it before Pi got it. */
export class CommandRejectedError extends Error {
  constructor(message: string, readonly by: "pi" | "daemon") {
    super(message);
    this.name = "CommandRejectedError";
  }
}

export function commandRejection(text: string): CommandRejectedError | undefined {
  const match = REFUSAL_MARK.exec(text);

  return match ? new CommandRejectedError(text.slice(match[0].length), match[1] as "pi" | "daemon") : undefined;
}

/** The daemon refused it; it is shown as a toast. Pi refusals show in the composer. */
export const isDaemonRefusal = (reason: unknown) => reason instanceof CommandRejectedError && reason.by === "daemon";
