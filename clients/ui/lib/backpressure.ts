export const HOST_BUSY = "Host is busy; try again";

export function busyRetryDelay(attempt: number): number | undefined {
  return attempt < 6 ? Math.min(100 * 2 ** attempt, 1000) : undefined;
}

export async function invokeWithBackpressure<T>(invoke: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await invoke(); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const delay = message === HOST_BUSY ? busyRetryDelay(attempt) : undefined;

      if (delay === undefined) throw reason;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
