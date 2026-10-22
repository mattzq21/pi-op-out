/** Pi answered a command with a failure, so the command had no effect. Daemon replies carry errors as text, so a first line marks it for the client. */
export const REJECTION_MARK = 'piop-rejected:\n';

export class PiRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiRejectedError';
  }
}
