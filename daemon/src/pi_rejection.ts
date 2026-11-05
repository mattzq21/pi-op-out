export type Refuser = 'pi' | 'daemon';

export class CommandRefusedError extends Error {
  constructor(message: string, readonly by: Refuser = 'pi') {
    super(message);
    this.name = 'CommandRefusedError';
  }
}

export const refusalText = (message: string, by: Refuser) => 'piop-refused:' + by + '\n' + message;

export function responseErrorText(error: unknown): string {
  if (error instanceof CommandRefusedError) return refusalText(error.message, error.by);
  return error instanceof Error ? error.message : String(error);
}
