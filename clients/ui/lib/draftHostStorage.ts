import { z } from "zod";
import { DraftStorage, durableDraftId, type DraftConflictSnapshot, type DraftDestination, type DurableDraft, type DurableSubmission } from "./draftStorage";
import { hostIdentity } from "./hostIdentity";
import { invoke } from "./platform";
import { appSettingsSchema } from "./responseSchemas";

const draftIdSchema = z.tuple([z.string(), z.string()]);

export class DraftHostStorage {
  private readonly storage = new DraftStorage();
  private readonly names = new Map<string, string>([["local", hostIdentity("Local")]]);
  private readonly conflicts = new WeakMap<DraftConflictSnapshot, DraftConflictSnapshot>();

  conflictCount() { return this.storage.conflictCount(); }

  private host(id: string, saving: boolean) {
    if (saving) {
      const name = this.names.get(id);

      if (!name) throw new Error("The draft's machine no longer has a saved name");

      return name;
    }

    return [...this.names].find(([, name]) => name === id)?.[0];
  }

  private key(key: string, saving: boolean) {
    const separator = key.lastIndexOf(":");
    const host = this.host(key.slice(0, separator), saving);

    return host === undefined ? undefined : `${host}:${key.slice(separator + 1)}`;
  }

  private id(id: string, saving: boolean) {
    const [endpoint, key] = draftIdSchema.parse(JSON.parse(id));
    const mapped = this.key(key, saving);

    if (mapped === undefined) throw new Error("The draft's machine is not saved on this client");

    return durableDraftId(endpoint, mapped);
  }

  private destination(destination: DraftDestination, saving: boolean): DraftDestination | undefined {
    const hostId = this.host(destination.hostId, saving);
    const key = this.key(destination.key, saving);

    return hostId === undefined || key === undefined ? undefined : { ...destination, hostId, key };
  }

  private draft(draft: DurableDraft, saving: boolean): DurableDraft[] {
    const key = this.key(draft.key, saving);

    if (key === undefined) return [];
    const destination = draft.destination ? this.destination(draft.destination, saving) : undefined;

    return [{ ...draft, key, id: durableDraftId(draft.endpoint, key), destination }];
  }

  private submission(submission: DurableSubmission, saving: boolean): DurableSubmission[] {
    const destination = this.destination(submission.destination, saving);

    return destination ? [{ ...submission, destination }] : [];
  }

  async load(endpoint: string) {
    const settings = await invoke("load_app_settings", undefined, appSettingsSchema);
    this.names.clear();
    this.names.set("local", hostIdentity("Local"));

    for (const host of settings.hosts) this.names.set(host.id, hostIdentity(host.name));
    const restored = await this.storage.load(endpoint);

    return { ...restored, drafts: restored.drafts.flatMap(draft => this.draft(draft, false)), submissions: restored.submissions.flatMap(submission => this.submission(submission, false)), emptyDrafts: [] };
  }

  private async includeHosts(keys: string[]) {
    if (keys.every(key => this.names.has(key.slice(0, key.lastIndexOf(":"))))) return;
    const settings = await invoke("load_app_settings", undefined, appSettingsSchema);

    for (const host of settings.hosts) if (!this.names.has(host.id)) this.names.set(host.id, hostIdentity(host.name));
  }

  async commit(drafts: DurableDraft[] = [], submissions: DurableSubmission[] = [], removeDrafts: string[] = [], removeSubmissions: string[] = []) {
    await this.includeHosts([...drafts.map(draft => draft.key), ...submissions.map(submission => submission.destination.key)]);
    await this.storage.commit(drafts.flatMap(draft => this.draft(draft, true)), submissions.flatMap(submission => this.submission(submission, true)), removeDrafts.map(id => this.id(id, true)), removeSubmissions);
  }

  async readConflicts(): Promise<DraftConflictSnapshot> {
    const stored = await this.storage.readConflicts();
    const snapshot = { changes: stored.changes.map(change => ({ ...change, id: change.store === "drafts" ? this.id(change.id, false) : change.id })), drafts: stored.drafts.flatMap(draft => this.draft(draft, false)), submissions: stored.submissions.flatMap(submission => this.submission(submission, false)) };
    this.conflicts.set(snapshot, stored);

    return snapshot;
  }

  acceptConflicts(snapshot: DraftConflictSnapshot) {
    const stored = this.conflicts.get(snapshot);

    if (!stored) throw new Error("Reload the changed drafts before accepting them");
    this.storage.acceptConflicts(stored);
  }
}
