import { createHash } from 'node:crypto';
import { serializeAppSettings, type AppSettings } from './settings_types';
import { publish as publishSettings, read as readSettingsRecord, type Publication as SettingsPublication } from './settings_records';
import { readRecord, writeRecord } from './settings_sync_storage';
import { settingsPath, storageLock, withExtension } from './settings_storage';
import * as settings from './settings';
import * as daemon from './daemon';
import * as daemonEndpoint from './daemon_endpoint';
import * as daemonRestart from './daemon_restart';
import * as peers from './peers';
import { sleep } from './util/sync';
import type { App } from './app';
import type { PiRuntime } from './pi_runtime';

const MAX_REVISION = 9_007_199_254_740_991;
let started = false;

interface Publication { revision: number; digest: string; agentHostId: string | null }
interface Progress { revision: number; synchronized: boolean; notified: boolean; phase_revision: number }

function defaultProgress(): Progress { return { revision: 0, synchronized: false, notified: false, phase_revision: 0 }; }

function digest(body: Buffer | string): string { return createHash('sha256').update(body).digest('hex'); }

function currentDigest(path: string): string { return digest(readSettingsRecord(path) ?? Buffer.alloc(0)); }

function journalPath(path: string): string { return withExtension(path, 'synchronization.json'); }

function progressPath(path: string): string {
  const owner = digest(daemonEndpoint.directory());
  return withExtension(path, `synchronization-${owner}.json`);
}

function nextRevision(revision: number): number {
  const next = revision + 1;
  if (next > MAX_REVISION) throw new Error('Settings revision limit was reached');
  return next;
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export class Journal {
  revision = 0;
  digest = '';
  agentRevisions = new Map<string, number>();
  publication: Publication | null = null;

  toJSON() { return { revision: this.revision, digest: this.digest, agentRevisions: sortedRecord(this.agentRevisions), publication: this.publication }; }

  publish(publication: Publication): void {
    this.revision = publication.revision;
    this.digest = publication.digest;
    if (publication.agentHostId !== null && publication.agentHostId !== undefined) this.agentRevisions.set(publication.agentHostId, this.revision);
    this.publication = null;
  }

  reconcile(path: string): void {
    const current = currentDigest(path);
    const publication = this.publication;
    this.publication = null;
    if (publication) {
      if (current === publication.digest) this.publish(publication);
      else if (current !== this.digest) this.publish({ ...publication, digest: current });
    }
    if (current !== this.digest) {
      this.revision = nextRevision(this.revision);
      this.digest = current;
    }
    writeRecord(journalPath(path), this);
  }

  static load(path: string): Journal {
    const raw: any = readRecord(journalPath(path), () => ({ revision: 0, digest: '', agentRevisions: {}, publication: null }));
    const journal = new Journal();
    if (typeof raw.revision !== 'number' || typeof raw.digest !== 'string') throw new Error(`Could not read settings synchronization record ${journalPath(path)}`);
    journal.revision = raw.revision;
    journal.digest = raw.digest;
    for (const [host, revision] of Object.entries(raw.agentRevisions ?? {})) journal.agentRevisions.set(host, Number(revision));
    journal.publication = raw.publication ?? null;
    journal.validate();
    journal.reconcile(path);
    return journal;
  }

  validate(): void {
    if (this.revision > MAX_REVISION || [...this.agentRevisions.values()].some(revision => revision > this.revision)) throw new Error('Invalid stored settings revision');
    if (this.publication && (this.publication.revision !== nextRevision(this.revision) || this.publication.digest.length !== 64)) throw new Error('Invalid prepared settings publication');
  }

  restoreAgents(runtime: PiRuntime, change: any, warnings: string[]): void {
    for (const [host, revision] of [...this.agentRevisions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      settings.publishSavedAgentRevision(runtime, host, revision, change, warnings);
    }
  }
}

export class Save {
  private constructor(private path: string, private progressPath: string, private journal: Journal, private publication: Publication) {}

  static prepare(path: string, body: Buffer, agentHostId: string | undefined): Save {
    const journal = Journal.load(path);
    const publication: Publication = { revision: nextRevision(journal.revision), digest: digest(body), agentHostId: agentHostId ?? null };
    const owner = progressPath(path);
    journal.publication = { ...publication };
    writeRecord(journalPath(path), journal);
    writeRecord(owner, { ...defaultProgress(), revision: publication.revision });
    return new Save(path, owner, journal, publication);
  }

  publish(body: Buffer, warnings: string[]): SettingsPublication {
    const result = publishSettings(this.path, body);
    if (result.error !== undefined) warnings.push(`Settings were published, but disk durability is unconfirmed: ${result.error}. Retry saving to confirm them.`);
    this.journal.publish({ ...this.publication });
    try { writeRecord(journalPath(this.path), this.journal); }
    catch (error: any) { warnings.push(`Settings were saved; durable revision publication will retry automatically: ${error.message ?? error}`); }
    return result;
  }

  change(current: AppSettings): any {
    return { settings: serializeAppSettings(current), committed: true, revision: this.journal.revision, committedRevision: this.publication.revision, source: digest(this.progressPath) };
  }

  restoreAgents(runtime: PiRuntime, change: any, warnings: string[]): void {
    this.journal.restoreAgents(runtime, change, warnings);
    if (this.publication.agentHostId !== null) change.agentConfigChange = { hostId: this.publication.agentHostId, revision: this.publication.revision };
    else delete change.agentConfigChange;
  }

  finish(change: any, warnings: string[]): void {
    const progress: Progress = { revision: this.journal.revision, synchronized: warnings.length === 0, notified: false, phase_revision: 1 };
    try { writeRecord(this.progressPath, progress); }
    catch (error: any) { warnings.push(`Settings were saved; synchronization acknowledgement will retry automatically: ${error.message ?? error}`); }
    change.synchronizationPending = warnings.length > 0;
    change.phaseRevision = progress.phase_revision;
  }
}

function readProgress(path: string): Progress { return readRecord(path, defaultProgress); }

function currentChange(path: string, journal: Journal): any {
  const current = settings.readSettingsAt(path);
  settings.mergeDiscoveredSkills(current);
  return { settings: serializeAppSettings(current), committed: true, revision: journal.revision, source: digest(progressPath(path)) };
}

export async function snapshot(app: App): Promise<any> {
  start(app);
  const path = await settingsPath();
  const storage = await storageLock(path);
  try {
    const journal = Journal.load(path);
    const progress = readProgress(progressPath(path));
    const change = currentChange(path, journal);
    const pending = progress.revision !== journal.revision || !progress.synchronized;
    change.synchronizationPending = pending;
    change.phaseRevision = progress.phase_revision;
    change.warnings = [];
    addPendingWarning(change, pending, journal.revision);
    return change;
  } finally { storage.release(); }
}

function notify(app: App, journal: Journal, change: any): void {
  app.emit('pi://settings-changed', change);
  for (const [host, revision] of [...journal.agentRevisions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    app.emit('pi://settings-changed', { ...change, agentConfigChange: { hostId: host, revision } });
  }
}

export async function publishCurrent(app: App, change: any): Promise<void> {
  await app.pi.lifecycle.run(async () => {
    const path = await settingsPath();
    const storage = await storageLock(path);
    try { publishLocked(app, path, Journal.load(path), change); } finally { storage.release(); }
  });
}

function publishLocked(app: App, path: string, journal: Journal, change: any): void {
  const ownerPath = progressPath(path);
  const progress = readProgress(ownerPath);
  const current = currentChange(path, journal);
  change.settings = current.settings;
  change.revision = journal.revision;
  change.source = current.source;
  canonicalAgentChange(journal, change);
  const pending = progress.revision !== journal.revision || !progress.synchronized;
  progress.phase_revision = nextRevision(progress.phase_revision);
  change.synchronizationPending = pending;
  change.phaseRevision = progress.phase_revision;
  addPendingWarning(change, pending, journal.revision);
  writeRecord(ownerPath, progress);
  notify(app, journal, change);
  if (progress.revision === journal.revision) {
    progress.notified = true;
    writeRecord(ownerPath, progress);
  }
}

function canonicalAgentChange(journal: Journal, change: any): void {
  const host = change.agentConfigChange?.hostId;
  if (typeof host === 'string' && journal.agentRevisions.has(host)) change.agentConfigChange = { hostId: host, revision: journal.agentRevisions.get(host) };
}

function addPendingWarning(change: any, pending: boolean, revision: number): void {
  if (!pending) return;
  const warnings = Array.isArray(change.warnings) ? change.warnings : [];
  if (warnings.length === 0) change.warnings = [`Settings were saved; synchronization of revision ${revision} is pending and will retry automatically.`];
}

interface Applied {
  revision?: number;
  notifiedRevision?: number;
  warnings: string[];
  sweep?: number;
}

function newApplied(): Applied { return { warnings: [] }; }

async function applyCurrent(app: App, runtime: PiRuntime, journal: Journal, current: AppSettings, change: any): Promise<string[]> {
  const warnings: string[] = [];
  journal.restoreAgents(runtime, change, warnings);
  try { await daemon.invalidateChanged(app, runtime, current); }
  catch (error: any) { warnings.push(`Saved settings invalidation is pending and will retry automatically: ${error.message ?? error}`); }
  if (warnings.length === 0) {
    try { await daemon.updateSettings(app, runtime, current); }
    catch (error: any) { warnings.push(`Saved settings synchronization is pending and will retry automatically: ${error.message ?? error}`); }
  }
  return warnings;
}

async function retryLocked(app: App, runtime: PiRuntime, path: string, applied: Applied): Promise<boolean> {
  const journal = Journal.load(path);
  const ownerPath = progressPath(path);
  const progress = readProgress(ownerPath);
  if (!needsRetry(journal, progress, applied)) return false;
  const phaseRevision = progress.revision === journal.revision ? progress.phase_revision : 0;
  writeRecord(ownerPath, { ...defaultProgress(), revision: journal.revision, phase_revision: phaseRevision });
  const current = settingsWithSkills(path);
  const change = currentChange(path, journal);
  const warnings = await applyCurrent(app, runtime, journal, current, change);
  change.warnings = warnings;
  change.synchronizationPending = warnings.length > 0;
  finishRetry(app, journal, ownerPath, change, warnings, applied);
  return true;
}

function needsRetry(journal: Journal, progress: Progress, applied: Applied): boolean {
  const sweep = applied.sweep === undefined || Date.now() - applied.sweep >= 30_000;
  return applied.revision !== journal.revision || progress.revision !== journal.revision || !progress.synchronized || !progress.notified || sweep;
}

function sameWarnings(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

function finishRetry(app: App, journal: Journal, ownerPath: string, change: any, warnings: string[], applied: Applied): void {
  const changed = applied.notifiedRevision !== journal.revision || !sameWarnings(applied.warnings, warnings);
  const progress = readProgress(ownerPath);
  progress.revision = journal.revision;
  progress.synchronized = warnings.length === 0;
  if (changed) {
    progress.phase_revision = nextRevision(progress.phase_revision);
    progress.notified = false;
    writeRecord(ownerPath, progress);
    change.phaseRevision = progress.phase_revision;
    notify(app, journal, change);
    applied.notifiedRevision = journal.revision;
    reportPhaseWarnings(app, warnings);
  }
  progress.notified = true;
  writeRecord(ownerPath, progress);
  if (warnings.length === 0) applied.revision = journal.revision;
  applied.sweep = Date.now();
  applied.warnings = [...warnings];
}

function reportPhaseWarnings(app: App, warnings: string[]): void {
  if (!warnings.length) return;
  const message = warnings.join('\n');
  console.error(message);
  app.emit('pi://daemon-error', { hostId: 'local', line: message });
}

async function retryCurrent(app: App, applied: Applied): Promise<boolean> {
  const gate = app.restart.gate.tryRead();
  if (!gate) return false;
  try {
    if (daemonRestart.blocking()) return false;
    const runtime = app.pi;
    const lifecycle = runtime.lifecycle.tryLock();
    if (!lifecycle) return false;
    try {
      const path = await settingsPath();
      const storage = await storageLock(path);
      try { return await retryLocked(app, runtime, path, applied); } finally { storage.release(); }
    } finally { lifecycle(); }
  } finally { gate(); }
}

export function start(app: App): void {
  if (started) return;
  started = true;
  void (async () => {
    let applied = newApplied();
    let lastError: string | undefined;
    for (;;) {
      await sleep(2000);
      let error: string | undefined;
      try {
        let refreshed = false;
        try { refreshed = await retryCurrent(app, applied); } catch (failure: any) { error = failure?.message ?? String(failure); }
        applyEffects(app, applied, refreshed);
      } catch (failure: any) { applied = newApplied(); error = failure?.message ?? String(failure); }
      if (lastError !== error) {
        if (error !== undefined) {
          console.error(`Saved settings synchronization will retry automatically: ${error}`);
          app.emit('pi://daemon-error', { hostId: 'local', line: `Saved settings synchronization will retry automatically: ${error}` });
        }
        lastError = error;
      }
    }
  })();
}

function applyEffects(app: App, applied: Applied, refreshed: boolean): void {
  if (refreshed) peers.invalidate(app);
}

function settingsWithSkills(path: string): AppSettings {
  const current = settings.readSettingsAt(path);
  settings.mergeDiscoveredSkills(current);
  return current;
}
