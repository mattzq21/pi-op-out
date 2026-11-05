const REFUSAL_MARK = /^piop-refused:(pi|daemon)\n/;

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

export const isDaemonRefusal = (reason: unknown) => reason instanceof CommandRejectedError && reason.by === "daemon";

// The error of a daemon answer: a refusal when the daemon or Pi refused the command.
export function daemonError(reason: unknown): unknown {
  const text = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : undefined;

  return (text === undefined ? undefined : commandRejection(text)) ?? reason;
}
