import { loadAppSettings } from './settings';
import { archivedSessionFile, desktopSessionFile } from './archives';
import { sessionIdentity } from './pi_launch';
import * as daemon from './daemon';
import type { App } from './app';

/** Holds a conversation change lease from the host supervisor until finished or released. */
export class MutationGuard {
  private finished = false;
  private committed = false;

  private constructor(private connection: daemon.Daemon, private token: string, private app: App) {}

  static async acquire(app: App, hostId: string, path: string, clientId: string, archived: boolean, operation: string): Promise<MutationGuard> {
    const settings = await loadAppSettings(app);
    const file = archived ? await archivedSessionFile(settings, hostId, path) : await desktopSessionFile(settings, hostId, path);
    const sessionId = await sessionIdentity(settings, hostId, file);
    const connection = await daemon.connect(app, app.pi, app.broker, settings, hostId);
    const result = await connection.request({ type: 'conversation_mutation', sessionId, sessionPath: file, clientId, archived, operation });
    if (typeof result?.token !== 'string') throw new Error('Conversation mutation token missing');
    return new MutationGuard(connection, result.token, app);
  }

  async finish(): Promise<void> {
    this.committed = true;
    await this.connection.request({ type: 'conversation_mutation_end', token: this.token, success: true });
    this.finished = true;
  }

  async finishCommitted(): Promise<void> { this.committed = true; await this.finish(); }

  async finishRestore(path: string): Promise<void> {
    this.finished = true;
    await this.connection.request({ type: 'conversation_mutation_end', token: this.token, success: true, restoredPath: path });
  }

  /** Ends the lease when it was not finished. */
  async release(): Promise<void> {
    if (this.finished) return;
    try {
      await this.connection.request({ type: 'conversation_mutation_end', token: this.token, success: this.committed });
      this.finished = true;
    } catch (error: any) {
      const line = `Could not release conversation ownership: ${error?.message ?? error}`;
      console.error(line);
      this.app.emit('pi://daemon-error', { hostId: this.connection.hostId, line });
    }
  }
}
