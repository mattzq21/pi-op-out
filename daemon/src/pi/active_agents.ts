import type { AgentAddress } from '../sessions';

// The agents that run on this daemon, by runtime ID or session key. It tells when a chat starts or stops working, so
// clients update that one chat and do not reload the chat list.
export class ActiveAgents extends Map<string, AgentAddress> {
  private working = new Set<string>();
  onRunning: (sessionId: string, running: boolean) => void = () => {};

  override set(key: string, agent: AgentAddress): this { super.set(key, agent); this.changed(); return this; }

  override delete(key: string): boolean { const deleted = super.delete(key); if (deleted) this.changed(); return deleted; }

  override clear(): void { super.clear(); this.changed(); }

  // Changes an agent's fields. Use this, not an assignment, so that a change of working is told.
  update(agent: AgentAddress, change: Partial<AgentAddress>): void { Object.assign(agent, change); this.changed(); }

  // The chats of this daemon that have a working agent.
  workingSessions(): Set<string> {
    return new Set([...this.values()].filter(agent => agent.hostId === 'local' && agent.working).map(agent => agent.sessionId).filter((id): id is string => id !== undefined));
  }

  private changed(): void {
    const next = this.workingSessions();
    const previous = this.working;
    this.working = next;
    for (const id of previous) if (!next.has(id)) this.onRunning(id, false);
    for (const id of next) if (!previous.has(id)) this.onRunning(id, true);
  }
}
