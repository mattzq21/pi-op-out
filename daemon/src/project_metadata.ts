import { MAX_REMOTE_HOSTS } from './settings_types';
import { isDirectory } from './environment';
import type { RemoteHost } from './settings_types';
import type { SessionSummary } from './types';
import { Mutex } from './util/sync';

const MAX_AGE = 15_000;

interface ProjectDetails { exists: boolean; linkedWorktree: boolean; checked: number }

function fresh(details: ProjectDetails, cwd: string, local: boolean): boolean {
  return Date.now() - details.checked < MAX_AGE && (!local || details.exists === isDirectory(cwd));
}

class HostProjects { target = ''; entries = new Map<string, ProjectDetails>(); lock = new Mutex(); }

/** Remembers for a short time whether each conversation folder exists. */
export class ProjectMetadataCache {
  private hosts = new Map<string, HostProjects>();

  private host(id: string): HostProjects {
    if (!this.hosts.has(id) && this.hosts.size > MAX_REMOTE_HOSTS) {
      const key = this.hosts.keys().next().value;
      if (key !== undefined) this.hosts.delete(key);
    }
    let host = this.hosts.get(id);
    if (!host) { host = new HostProjects(); this.hosts.set(id, host); }
    return host;
  }

  /** Clears the cache for the host when the returned function is called. */
  invalidateAfter(hostId: string): () => void {
    const host = this.host(hostId);
    return () => host.entries.clear();
  }

  async inspect(sessions: SessionSummary[], host: RemoteHost | undefined, inspect: (pending: SessionSummary[]) => Promise<void>): Promise<void> {
    const cache = this.host(host?.id ?? 'local');
    await cache.lock.run(async () => {
      const target = host?.target ?? '';
      if (cache.target !== target) { cache.entries.clear(); cache.target = target; }
      const seen = new Set<string>();
      const pending: SessionSummary[] = [];
      for (const session of sessions) {
        if (seen.has(session.cwd)) continue;
        seen.add(session.cwd);
        const entry = cache.entries.get(session.cwd);
        if (!entry || !fresh(entry, session.cwd, host === undefined)) pending.push({ ...session });
      }
      await inspect(pending);
      for (const cwd of [...cache.entries.keys()]) if (!seen.has(cwd)) cache.entries.delete(cwd);
      for (const session of pending) cache.entries.set(session.cwd, { exists: session.cwdExists, linkedWorktree: session.linkedWorktree === true, checked: Date.now() });
      for (const session of sessions) {
        const details = cache.entries.get(session.cwd);
        if (details) { session.cwdExists = details.exists; session.linkedWorktree = details.linkedWorktree; }
      }
    });
  }
}
