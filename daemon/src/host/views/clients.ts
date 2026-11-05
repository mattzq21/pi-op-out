import { jsonEqual } from '../json';
import type { ReadonlyView } from './readonly';
import type { Session } from '../session';

// What the Host keeps about each client view. A runtime ID is one client window, or one hidden helper, that shows one conversation.
// - Its request is what the client asked for when it attached.
// - An owned view is subscribed to the running session of its conversation.
// - A view that does not own its conversation is read-only.
export class ClientViews {
  private requests = new Map<string, any>();
  private requestEpochs = new WeakMap<object, string>();
  private subscribed = new Map<string, Session>();
  private readonlyViews = new Map<string, ReadonlyView>();

  request(runtime: string): any | undefined { return this.requests.get(runtime); }

  // The epoch, when given, is the session that the request was saved for.
  setRequest(runtime: string, request: any, epoch?: string): void {
    this.requests.set(runtime, request);
    if (epoch !== undefined) this.requestEpochs.set(request, epoch);
  }

  isRequest(runtime: string, request: any): boolean { return this.requests.get(runtime) === request; }

  dropRequest(runtime: string): void { this.requests.delete(runtime); }

  // True when a view of this client still asks for this conversation.
  requestedBy(clientId: unknown, sessionKey: unknown): boolean {
    for (const request of this.requests.values()) if (jsonEqual(request?.clientId, clientId) && jsonEqual(request?.sessionKey, sessionKey)) return true;
    return false;
  }

  requestedFor(identity: string): boolean {
    for (const request of this.requests.values()) if (request?.sessionKey === identity) return true;
    return false;
  }

  session(runtime: string): Session | undefined { return this.subscribed.get(runtime); }

  isCurrent(runtime: string, session: Session): boolean { return this.subscribed.get(runtime)?.epoch === session.epoch; }

  subscribe(runtime: string, session: Session): void {
    this.readonlyViews.delete(runtime);
    this.subscribed.set(runtime, session);
  }

  unsubscribe(runtime: string): Session | undefined {
    const session = this.subscribed.get(runtime);
    this.subscribed.delete(runtime);
    return session;
  }

  readonly(runtime: string): ReadonlyView | undefined {
    const view = this.readonlyViews.get(runtime);
    return view && { ...view };
  }

  showReadonly(runtime: string, view: ReadonlyView): void { this.readonlyViews.set(runtime, { ...view }); }

  clearReadonly(runtime: string): void { this.readonlyViews.delete(runtime); }

  readonlyRuntimes(identity: string): string[] {
    return [...this.readonlyViews].filter(([, view]) => view.id === identity).map(([runtime]) => runtime);
  }

  // The saved path that a read-only view of this conversation shows, if any view shows it.
  readonlyPath(identity: string): string | null | undefined {
    for (const view of this.readonlyViews.values()) if (view.id === identity) return view.path;
    return undefined;
  }

  runtimesOf(identity: string): Set<string> {
    const runtimes = new Set(this.readonlyRuntimes(identity));
    for (const [runtime, session] of this.subscribed) if (session.identity === identity) runtimes.add(runtime);
    return runtimes;
  }

  // Removes all that is kept for a view. Returns the session it was subscribed to.
  forget(runtime: string): Session | undefined {
    this.requests.delete(runtime);
    this.readonlyViews.delete(runtime);
    return this.unsubscribe(runtime);
  }

  // A session stopped: its views are no longer subscribed. A view loses its request too, unless it is read-only or asked again since.
  sessionClosed(session: Session): void {
    for (const [runtime, current] of [...this.subscribed]) {
      if (current !== session) continue;
      this.subscribed.delete(runtime);
      const request = this.requests.get(runtime);
      if (!this.readonlyViews.has(runtime) && request && this.requestEpochs.get(request) === session.epoch) this.requests.delete(runtime);
    }
  }
}
