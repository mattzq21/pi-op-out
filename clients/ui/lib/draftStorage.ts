import { cachedMobileHost } from "./mobileHosts";
import { z } from "zod";
import { imageAttachmentSchema } from "./responseSchemas";
import { isMobile } from "./platform";
import { remoteClient } from "./remoteClient";
import { upgradeDraftStorage } from "./draftStorageMigration";
import { DraftRevisions, type DraftMutation } from "./draftStorageRevisions";

const uploadSchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["image", "text"]), byteSize: z.number(), image: imageAttachmentSchema.optional(), text: z.string().optional() }).refine(upload => upload.kind === "image" ? Boolean(upload.image) : upload.text !== undefined, "Attachment content is missing");

export const draftDestinationSchema = z.object({ key: z.string(), endpoint: z.string(), hostId: z.string(), cwd: z.string().optional(), sessionPath: z.string().optional(), temporary: z.boolean() });

export const durableDraftSchema = z.object({ id: z.string(), endpoint: z.string(), key: z.string(), destination: draftDestinationSchema.optional(), text: z.string(), uploads: z.array(uploadSchema), updatedAt: z.number(), retrySubmission: z.object({ id: z.string(), fingerprint: z.string() }).optional() });

export const durableSubmissionSchema = z.object({ id: z.string(), destination: draftDestinationSchema, rawText: z.string(), uploads: z.array(uploadSchema), status: z.enum(["preparing", "uncertain"]), createdAt: z.number(), error: z.string().optional() });

export type DraftDestination = z.infer<typeof draftDestinationSchema>;

export type DurableDraft = z.infer<typeof durableDraftSchema>;

export type DurableSubmission = z.infer<typeof durableSubmissionSchema>;

export interface DraftStorageIssue { kind: "draft" | "submission" | "attachment" | "storage"; id: string; message: string }

export interface DraftConflictSnapshot { changes: DraftMutation[]; drafts: DurableDraft[]; submissions: DurableSubmission[] }

const storedDraftSchema = durableDraftSchema.omit({ uploads: true }).extend({ version: z.literal(2), uploadIds: z.array(z.string()) });

const storedSubmissionSchema = durableSubmissionSchema.omit({ uploads: true }).extend({ version: z.literal(2), uploadIds: z.array(z.string()) });

const storedAttachmentSchema = z.object({ id: z.string(), endpoint: z.string(), upload: uploadSchema });

const identitySchema = z.object({ id: z.string(), endpoint: z.string().optional(), destination: z.object({ endpoint: z.string() }).optional() });



const endpointSchema = z.union([z.object({ endpoint: z.string() }), z.object({ destination: z.object({ endpoint: z.string() }) }).transform(record => ({ endpoint: record.destination.endpoint }))]);

export function draftEndpoint() {
  if (!isMobile) return "desktop";
  const connected = remoteClient.connectionIdentity();

  if (connected) return connected;

  return cachedMobileHost() || "mobile";
}

export const durableDraftId = (endpoint: string, key: string) => JSON.stringify([endpoint, key]);

const attachmentId = (endpoint: string, id: string) => JSON.stringify([endpoint, id]);

function storageIssue(kind: DraftStorageIssue["kind"], id: string, detail: string): DraftStorageIssue {
  return { kind, id, message: `Saved ${kind} ${id} could not be restored: ${detail}. Its stored content has been retained.` };
}

function recordScope(input: z.JSONType, endpoint: string) {
  const scope = endpointSchema.safeParse(input);

  if (scope.success && scope.data.endpoint !== endpoint) return { id: "(other endpoint)", damaged: false, belongs: false };
  const identity = identitySchema.safeParse(input);

  if (!identity.success) return { id: "(unidentified record)", damaged: true, belongs: true };
  const recordedEndpoint = identity.data.endpoint ?? identity.data.destination?.endpoint;

  return { id: identity.data.id, damaged: !recordedEndpoint, belongs: !recordedEndpoint || recordedEndpoint === endpoint };
}

function referencedUploads(ids: string[], attachments: Map<string, z.infer<typeof uploadSchema>>) {
  return ids.map(id => {
    const upload = attachments.get(id);

    if (!upload) throw new Error(`Attachment ${id} is missing or damaged`);

    return upload;
  });
}

function readDraft(input: z.JSONType, attachments: Map<string, z.infer<typeof uploadSchema>>) {
  const stored = storedDraftSchema.parse(input);
  const draft = durableDraftSchema.parse({ ...stored, uploads: referencedUploads(stored.uploadIds, attachments) });

  if (draft.id !== durableDraftId(draft.endpoint, draft.key)) throw new Error("Draft identity is inconsistent");

  if (draft.destination && (draft.destination.endpoint !== draft.endpoint || draft.destination.key !== draft.key)) throw new Error("Draft destination is inconsistent");

  return draft;
}

function readAttachment(input: z.JSONType) {
  const attachment = storedAttachmentSchema.parse(input);

  if (attachment.id !== attachmentId(attachment.endpoint, attachment.upload.id)) throw new Error("Attachment identity is inconsistent");

  return attachment;
}

function readSubmission(input: z.JSONType, attachments: Map<string, z.infer<typeof uploadSchema>>) {
  const stored = storedSubmissionSchema.parse(input);

  return durableSubmissionSchema.parse({ ...stored, uploads: referencedUploads(stored.uploadIds, attachments) });
}

function cleanUnusedAttachments(transaction: IDBTransaction, healthy: Set<string>) {
  const draftRequest = transaction.objectStore("drafts").getAll();
  const submissionRequest = transaction.objectStore("submissions").getAll();
  submissionRequest.onsuccess = () => {
    const drafts = z.array(storedDraftSchema).safeParse(draftRequest.result);
    const submissions = z.array(storedSubmissionSchema).safeParse(submissionRequest.result);

    if (!drafts.success || !submissions.success) return;
    const referenced = new Set([...drafts.data, ...submissions.data].flatMap(record => record.uploadIds));
    const store = transaction.objectStore("attachments");
    const cursor = store.openKeyCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;

      if (!entry) return;

      if (healthy.has(String(entry.primaryKey)) && !referenced.has(String(entry.primaryKey))) store.delete(entry.primaryKey);
      entry.continue();
    };
  };
}

export class DraftStorage {
  private database?: Promise<IDBDatabase>;
  private readonly damagedDrafts = new Set<string>();
  private readonly damagedSubmissions = new Set<string>();
  private readonly healthyAttachments = new Set<string>();
  private readonly revisions = new DraftRevisions();
  private retainedLegacy = false;

  conflictCount() { return this.revisions.count(); }

  private open() {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("piop-conversation-drafts", 3);
      let blocked = false;
      request.onupgradeneeded = () => {
        if (!request.transaction) throw new Error("Draft storage transaction is unavailable");
        upgradeDraftStorage(request.result, request.transaction);
      };

      request.onerror = () => reject(request.error ?? new Error("Could not open draft storage"));
      request.onblocked = () => { blocked = true; reject(new Error("Draft storage is blocked by another window. Close it and retry.")); };

      request.onsuccess = () => {
        const database = request.result;

        if (blocked) { database.close();

        return; }

        database.onversionchange = () => { database.close(); this.database = undefined; };

        resolve(database);
      };
    });

    return this.database.catch(reason => { this.database = undefined; throw reason; });
  }

  private readAttachments(inputs: z.JSONType[], issues: DraftStorageIssue[]) {
    const attachments = new Map<string, z.infer<typeof uploadSchema>>();

    for (const input of inputs) {
      try {
        const stored = readAttachment(input);
        attachments.set(stored.id, stored.upload); this.healthyAttachments.add(stored.id);
      } catch (reason) { const identity = identitySchema.safeParse(input); issues.push(storageIssue("attachment", identity.success ? identity.data.id : "(unidentified record)", String(reason))); }
    }

    return attachments;
  }

  private readDrafts(inputs: z.JSONType[], endpoint: string, attachments: Map<string, z.infer<typeof uploadSchema>>, issues: DraftStorageIssue[]) {
    const drafts: DurableDraft[] = [];
    const empty: DurableDraft[] = [];

    for (const input of inputs) {
      const scope = recordScope(input, endpoint);

      if (!scope.belongs) continue;

      try {
        if (scope.damaged) throw new Error("Destination identity is missing");
        const draft = readDraft(input, attachments);
        drafts.push(draft);
        this.revisions.observe("drafts", draft.id, input);

        if (!draft.text && !draft.uploads.length) empty.push(draft);
      } catch (reason) { this.damagedDrafts.add(scope.id); issues.push(storageIssue("draft", scope.id, String(reason))); }
    }

    return { drafts, empty };
  }

  private readSubmissions(inputs: z.JSONType[], endpoint: string, attachments: Map<string, z.infer<typeof uploadSchema>>, issues: DraftStorageIssue[]) {
    const submissions: DurableSubmission[] = [];

    for (const input of inputs) {
      const scope = recordScope(input, endpoint);

      if (!scope.belongs) continue;

      try {
        if (scope.damaged) throw new Error("Destination identity is missing");
        const submission = readSubmission(input, attachments);
        submissions.push(submission);
        this.revisions.observe("submissions", submission.id, input);

      } catch (reason) { this.damagedSubmissions.add(scope.id); issues.push(storageIssue("submission", scope.id, String(reason))); }
    }

    return { submissions };
  }

  async load(endpoint: string) {
    const database = await this.open();

    const restored = await new Promise<{ drafts: DurableDraft[]; submissions: DurableSubmission[]; emptyDrafts: DurableDraft[]; issues: DraftStorageIssue[] }>((resolve, reject) => {
      const stores = ["drafts", "submissions", "attachments"];
      const transaction = database.transaction(stores, "readonly");
      const drafts = transaction.objectStore("drafts").getAll();
      const submissions = transaction.objectStore("submissions").getAll();
      const uploads = transaction.objectStore("attachments").index("endpoint").getAll(endpoint);
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not read saved drafts"));
      transaction.oncomplete = () => {
        const issues: DraftStorageIssue[] = [];
        this.revisions.reset();
        const attachments = this.readAttachments(uploads.result, issues);
        const restoredDrafts = this.readDrafts(drafts.result, endpoint, attachments, issues);
        const restoredSubmissions = this.readSubmissions(submissions.result, endpoint, attachments, issues);
        resolve({ drafts: restoredDrafts.drafts, submissions: restoredSubmissions.submissions, emptyDrafts: restoredDrafts.empty, issues });
      };
    });

    try { await this.commit(restored.emptyDrafts, []); }
    catch (reason) { restored.issues.push(storageIssue("storage", "empty drafts", String(reason))); }

    return restored;
  }

  async readConflicts(): Promise<DraftConflictSnapshot> {
    const database = await this.open();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(["drafts", "submissions", "attachments"], "readonly");
      const changes = this.revisions.readChanged(transaction);
      const uploads = transaction.objectStore("attachments").getAll();
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not read changed saved input"));
      transaction.oncomplete = () => {
        try {
          const attachments = this.readAttachments(uploads.result, []);
          const drafts = changes.flatMap(change => change.store === "drafts" && change.value !== undefined ? [readDraft(change.value, attachments)] : []);
          const submissions = changes.flatMap(change => change.store === "submissions" && change.value !== undefined ? [readSubmission(change.value, attachments)] : []);
          resolve({ changes, drafts, submissions });
        } catch (reason) { reject(reason); }
      };
    });
  }

  acceptConflicts(snapshot: DraftConflictSnapshot) { this.revisions.accept(snapshot.changes); }

  private stageUploads(store: IDBObjectStore, endpoint: string, uploads: DurableDraft["uploads"], staged: Map<string, string>) {
    return uploads.map(upload => {
      const id = attachmentId(endpoint, upload.id);
      const content = JSON.stringify(uploadSchema.parse(upload));

      if (staged.has(id)) {
        if (staged.get(id) !== content) throw new Error("An attachment identity was reused for different content");

        return id;
      }

      staged.set(id, content);
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result === undefined) { store.put({ id, endpoint, upload }); this.healthyAttachments.add(id); }
        else this.verifyAttachment(store, id, request.result, upload);
      };

      return id;
    });
  }

  private verifyAttachment(store: IDBObjectStore, id: string, value: z.JSONType, upload: DurableDraft["uploads"][number]) {
    try {
      const previous = readAttachment(value);

      if (JSON.stringify(previous.upload) !== JSON.stringify(uploadSchema.parse(upload))) throw new Error("An attachment identity was reused for different content");
      this.healthyAttachments.add(id);
    } catch { store.transaction.abort(); }
  }

  private validateChanges(drafts: DurableDraft[], submissions: DurableSubmission[], removeDrafts: string[], removeSubmissions: string[]) {
    for (const draft of drafts) durableDraftSchema.parse(draft);

    for (const submission of submissions) durableSubmissionSchema.parse(submission);
    const damagedDraft = drafts.find(draft => this.damagedDrafts.has(draft.id));
    const damagedSubmission = submissions.find(submission => this.damagedSubmissions.has(submission.id));

    const removesDamaged = removeDrafts.some(id => this.damagedDrafts.has(id)) || removeSubmissions.some(id => this.damagedSubmissions.has(id));

    if (damagedDraft || damagedSubmission || removesDamaged) throw new Error("This destination has damaged saved content. Copy your input to a new conversation; the damaged record has been preserved.");
  }

  async commit(drafts: DurableDraft[] = [], submissions: DurableSubmission[] = [], removeDrafts: string[] = [], removeSubmissions: string[] = []) {
    this.validateChanges(drafts, submissions, removeDrafts, removeSubmissions);
    const database = await this.open();
    const changes = draftMutations(drafts, submissions, removeDrafts, removeSubmissions);

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["drafts", "submissions", "attachments"], "readwrite", { durability: "strict" });
      const attachments = transaction.objectStore("attachments");
      const staged = new Map<string, string>();
      let failure: Error | undefined;
      this.revisions.check(transaction, changes, conflict => {
        if (conflict) { failure = conflict; transaction.abort();

          return; }

        try {
          for (const draft of drafts) this.stageUploads(attachments, draft.endpoint, draft.uploads, staged);

          for (const submission of submissions) this.stageUploads(attachments, submission.destination.endpoint, submission.uploads, staged);

          for (const change of changes) {
            const store = transaction.objectStore(change.store);

            if (change.value === undefined) store.delete(change.id);
            else store.put(change.value);
          }

          if (!this.retainedLegacy) cleanUnusedAttachments(transaction, this.healthyAttachments);
        } catch (reason) { failure = new Error(String(reason)); transaction.abort(); }
      });

      transaction.oncomplete = () => { this.revisions.accept(changes); resolve(); };

      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Could not save draft content"));
    });
  }
}

function draftMutations(drafts: DurableDraft[], submissions: DurableSubmission[], removeDrafts: string[], removeSubmissions: string[]) {
  const changes = new Map<string, DraftMutation>();
  const add = (change: DraftMutation) => changes.set(JSON.stringify([change.store, change.id]), change);

  for (const draft of drafts) {
    const { uploads, ...record } = draft;
    const value = draft.text || uploads.length ? JSON.parse(JSON.stringify({ ...record, revision: crypto.randomUUID(), version: 2, uploadIds: uploads.map(upload => attachmentId(draft.endpoint, upload.id)) })) : undefined;
    add({ store: "drafts", id: draft.id, value });
  }

  for (const submission of submissions) {
    const { uploads, ...record } = submission;
    const value = JSON.parse(JSON.stringify({ ...record, revision: crypto.randomUUID(), version: 2, uploadIds: uploads.map(upload => attachmentId(submission.destination.endpoint, upload.id)) }));
    add({ store: "submissions", id: submission.id, value });
  }

  for (const id of removeDrafts) add({ store: "drafts", id });

  for (const id of removeSubmissions) add({ store: "submissions", id });

  return [...changes.values()];
}
