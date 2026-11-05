import { locateSessionFile } from './archives';
import { sessionIdentity } from '../pi';
import { localHost } from '../local_host';
import type { Host, MutationRequest } from '../host';
import type { App } from '../app';

export class MutationGuard {
  private finished = false;
  private committed = false;

  private constructor(private host: Host, private token: string, private app: App) {}

  static async acquire(app: App, path: string, clientId: string, archived: boolean, operation: MutationRequest['operation']): Promise<MutationGuard> {
    const file = await locateSessionFile(path, archived);
    const sessionId = await sessionIdentity(file);
    const host = localHost(app).host;
    const result = await host.beginMutation({ sessionId, sessionPath: file, clientId, archived, operation });
    if (typeof result?.token !== 'string') throw new Error('Conversation mutation token missing');
    return new MutationGuard(host, result.token, app);
  }

  async finish(): Promise<void> {
    this.committed = true;
    await this.host.endMutation({ token: this.token, success: true });
    this.finished = true;
  }

  async finishCommitted(): Promise<void> { this.committed = true; await this.finish(); }

  async finishRestore(path: string): Promise<void> {
    this.finished = true;
    await this.host.endMutation({ token: this.token, success: true, restoredPath: path });
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
