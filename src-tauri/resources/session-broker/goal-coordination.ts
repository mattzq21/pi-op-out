import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export class GoalCoordination {
  private pending: Promise<unknown> = Promise.resolve();
  run<T>(ctx: ExtensionContext, operation: () => T): Promise<T> {
    const sessionId = ctx.sessionManager.getSessionId();

    const next = this.pending.then(() => {
      if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("The conversation changed before the goal operation could run.");

      return operation();
    });

    this.pending = next.catch(() => undefined);

    return next;
  }
}
