import { randomUUID } from 'node:crypto';
import { flag, text } from './json';
import { ownershipError, type Guard } from './ownership';
import { clearSaved } from './queue';
import { announceRemoved } from './readonly_views';
import type { Host } from './controller';

export class MutationGuards {
  private guards = new Map<string, [Guard, string]>();

  constructor(private host: Host) {}

  active(): boolean { return this.guards.size > 0; }

  async begin(packet: any): Promise<any> {
    const operation = text(packet, 'operation');
    const guard = await this.host.ownership().begin(text(packet, 'sessionId'), text(packet, 'clientId'), {
      mutation: true, archive: operation === 'archive', delete: operation === 'delete', relocate: operation === 'relocate', path: packet.sessionPath ?? null, archived: packet.archived ?? null,
    });
    if (!guard.owned) { guard.drop(); throw new Error(ownershipError()); }
    const token = randomUUID();
    this.guards.set(token, [guard, operation]);
    return { token };
  }

  async end(packet: any): Promise<any> {
    const host = this.host;
    const token = text(packet, 'token');
    const entry = this.guards.get(token);
    this.guards.delete(token);
    if (!entry) return null;
    const [guard, operation] = entry;
    if (operation === 'restore') {
      if (flag(packet, 'success')) guard.restoreFinished(host.ownership(), null);
      else guard.release(host.ownership(), false);
      return null;
    }
    const deletedId = operation === 'delete' && flag(packet, 'success') && typeof guard.saved?.header?.id === 'string' ? guard.saved.header.id : undefined;
    const removed = flag(packet, 'success') && (operation === 'delete' || operation === 'archive');
    guard.release(host.ownership(), removed);
    if (deletedId !== undefined) {
      await clearSaved(host.storageRoot(), deletedId);
      host.dropQueuedInput(deletedId);
    }
    if (removed) announceRemoved(host, guard.id);
    return null;
  }

  dropAll(): void {
    for (const [guard] of this.guards.values()) guard.drop();
    this.guards.clear();
  }
}
