/** A command was refused, so it had no effect. Pi refused it, or the daemon refused it before Pi got it. Daemon replies carry errors as text, so a first line marks it for the client. */
export type Refuser = 'pi' | 'daemon';

export class CommandRefusedError extends Error {
  constructor(message: string, readonly by: Refuser = 'pi') {
    super(message);
    this.name = 'CommandRefusedError';
  }
}

export const refusalText = (message: string, by: Refuser) => 'piop-refused:' + by + '\n' + message;
