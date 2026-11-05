import { locateSessionFile } from './archives';
import { sessionIdentity, localHost } from '../pi';
import type { Host, MutationRequest } from '../host';
import type { App } from '../app';
import { lifecycle as SessionLifecycle } from '../storage';
import { profileRoot } from '../host_operations';

export class MutationGuard {
  private finished = false;
  private committed = false;

  private constructor(private host: Host, private token: string, private app: App) {}

  // Holds the saved chat sessionId for one change, so no client or runtime changes it meanwhile.
  static async acquire(app: App, sessionId: string, clientId: string, operation: MutationRequest['operation']): Promise<MutationGuard> {
    const saved = SessionLifecycle.session(profileRoot(), sessionId);
    if (!saved) throw new Error('This conversation has been deleted');
    if (operation !== 'delete' && saved.archived !== (operation === 'restore')) throw new Error(saved.archived ? 'This conversation has been deleted or archived' : 'This conversation is not archived');
    const host = localHost(app).host;
    const result = await host.beginMutation({ sessionId, sessionPath: saved.sessionPath, clientId, archived: saved.archived, operation });
    if (typeof result?.token !== 'string') throw new Error('Conversation mutation token missing');
    return new MutationGuard(host, result.token, app);
  }

  async finish(): Promise<void> {
    this.committed = true;
    await this.host.endMutation({ token: this.token, success: true });
    this.finished = true;
  }

  async release(): Promise<void> {
    if (this.finished) return;
    try {
      await this.host.endMutation({ token: this.token, success: this.committed });
      this.finished = true;
    } catch (error: any) {
      const line = `Could not release conversation ownership: ${error?.message ?? error}`;
      console.error(line);
      this.app.emit('pi://daemon-error', { hostId: 'local', line });
    }
  }
}
