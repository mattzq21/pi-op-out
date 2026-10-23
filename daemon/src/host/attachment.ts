import { flag, jsonEqual, text } from './json';
import type { Guard } from './ownership';
import { argument, expandHome, isUuid, parseLaunchSpec, specIdentity, type LaunchSpec, type SessionLaunch } from './protocol';
import { lockGate } from './lock_gate';
import type { Host } from './controller';
import type { Session } from './session';

/** Attaches a view to a conversation. The owning client's view starts the session when needed; other views attach read-only. */
export async function attach(host: Host, packet: any): Promise<any> {
  const attachment = new Attachment(host, packet);
  if (flag(attachment.packet.presence, 'readOnly')) return attachment.readonly();
  let guard: Guard;
  try { guard = await attachment.ownership(); } catch (error) {
    await attachment.cleanup(undefined, false, true);
    throw error;
  }
  const owned = guard.owned;
  const opened: { session?: Session } = {};
  let result: any;
  let failure: unknown;
  try { result = await attachment.open(guard, opened); } catch (error) { failure = error ?? new Error('Attach failed'); }
  let releaseError: unknown;
  try { guard.release(host.ownership(), false); } catch (error) { releaseError = error; }
  await attachment.cleanup(opened.session, owned, failure !== undefined || releaseError !== undefined);
  if (releaseError !== undefined) throw releaseError;
  if (failure !== undefined) throw failure;
  return result;
}

class Attachment {
  readonly runtime: string;
  readonly spec: LaunchSpec;
  readonly identity: string;
  readonly path: string | null;
  /** The record this attachment keeps in host.attachments; remember() replaces the original packet with a copy. */
  private stored: any;

  constructor(private host: Host, readonly packet: any) {
    this.runtime = text(packet, 'runtimeId');
    this.spec = parseLaunchSpec(packet.spec);
    const key = text(packet, 'sessionKey');
    this.identity = specIdentity(this.spec, key);
    if (isUuid(key) && this.identity !== key) throw new Error('The saved path belongs to another conversation; resolve its identity again');
    this.path = argument(this.spec, '--session') ?? null;
    this.stored = packet;
    host.attachments.set(this.runtime, packet);
    this.assertCurrent();
  }

  private assertCurrent(): void {
    if (this.host.attachments.get(this.runtime) !== this.stored) throw new Error('The conversation was closed while attaching');
  }

  readonly(): any {
    this.host.ownership().lookup(this.identity);
    this.assertCurrent();
    return this.attachReadonly();
  }

  private attachReadonly(): any {
    this.host.readonlyMap.set(this.runtime, { id: this.identity, path: this.path });
    return { attached: true, owned: false };
  }

  ownership(): Promise<Guard> {
    return this.host.ownership().begin(this.identity, text(this.packet, 'clientId'), { take: this.packet.takeOwnership ?? null, path: this.path, create: this.path === null });
  }

  async open(guard: Guard, opened: { session?: Session }): Promise<any> {
    this.assertCurrent();
    if (!guard.owned) return this.attachReadonly();
    const release = await lockGate(this.host.sessionGates, this.identity);
    try {
      const session = await this.session(guard);
      opened.session = session;
      await session.setClientId(text(this.packet, 'clientId'));
      await session.execute({ type: 'get_state' });
      this.assertCurrent();
      this.host.readonlyMap.delete(this.runtime);
      this.host.attachView(this.runtime, session, structuredClone(this.packet.presence ?? null));
      this.host.remember(this.runtime, session);
      this.stored = this.host.attachments.get(this.runtime);
      this.host.reconcile(session);
      return { attached: session.views().length > 1 || session.submitted(), owned: true };
    } finally { release(); }
  }

  private async session(guard: Guard): Promise<Session> {
    let session = this.host.findSession(this.identity);
    if (session?.transient()) throw new Error('This conversation branch is still being prepared');
    if (session?.stopping()) {
      await session.stop();
      session = this.host.findSession(this.identity);
    }
    return session ?? await this.host.spawnSession(this.launch(guard));
  }

  private launch(guard: Guard): SessionLaunch {
    const savedCwd = guard.saved?.header?.cwd;
    const raw = typeof savedCwd === 'string' ? savedCwd : (typeof this.packet.cwd === 'string' ? this.packet.cwd : null);
    const cwd = raw === null ? null : expandHome(raw, this.host.home);
    const spec: LaunchSpec = { program: this.spec.program, args: [...this.spec.args], env: { ...this.spec.env }, cwd: this.spec.cwd };
    if (spec.env.PIOP_REMOTE_SESSION_CLAIMS !== undefined) spec.env.PIOP_SESSION_CWD = cwd ?? '~';
    else if (cwd !== null) spec.cwd = cwd;
    const timeout = this.packet.timeout;
    return {
      key: this.identity, spec,
      timeout: typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 0 ? timeout : 630000,
      transient: false, clientId: text(this.packet, 'clientId'), cwd,
    };
  }

  private stillAttached(opened: Session | undefined): boolean {
    const current = this.host.subscriptions.get(this.runtime);
    return (current !== undefined && opened !== undefined && current === opened) || this.host.attachments.get(this.runtime) === this.stored;
  }

  async cleanup(opened: Session | undefined, owned: boolean, failed = false): Promise<void> {
    if (failed && this.host.attachments.get(this.runtime) === this.stored) {
      this.host.attachments.delete(this.runtime);
      this.host.readonlyMap.delete(this.runtime);
      if (opened && this.host.subscriptions.get(this.runtime) === opened) {
        this.host.subscriptions.delete(this.runtime);
        opened.detachView(this.runtime);
      }
    }
    if (this.stillAttached(opened)) return;
    if (opened) {
      if (!opened.views().length) {
        if (!opened.submitted() && opened.idle() && this.host.canStopIdle(opened)) await opened.stop();
        else await this.host.releaseUnused(opened);
      }
    } else if (owned) {
      await this.host.ownership().releaseClient(this.identity, text(this.packet, 'clientId'), () =>
        ![...this.host.attachments.values()].some(value => jsonEqual(value?.clientId, this.packet.clientId) && jsonEqual(value?.sessionKey, this.packet.sessionKey)));
    }
  }
}
