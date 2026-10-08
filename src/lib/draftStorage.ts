import { z } from "zod";
import { imageAttachmentSchema } from "./responseSchemas";
import { isMobile } from "./platform";
import { remoteClient } from "./remoteClient";

const uploadSchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["image", "text"]), byteSize: z.number(), image: imageAttachmentSchema.optional(), text: z.string().optional() }).refine(upload => upload.kind === "image" ? Boolean(upload.image) : upload.text !== undefined, "Attachment content is missing");

export const draftDestinationSchema = z.object({ key: z.string(), endpoint: z.string(), hostId: z.string(), cwd: z.string().optional(), sessionPath: z.string().optional(), temporary: z.boolean() });

export const durableDraftSchema = z.object({ id: z.string(), endpoint: z.string(), key: z.string(), destination: draftDestinationSchema.optional(), text: z.string(), uploads: z.array(uploadSchema), updatedAt: z.number(), retrySubmission: z.object({ id: z.string(), fingerprint: z.string() }).optional() });

export const durableSubmissionSchema = z.object({ id: z.string(), destination: draftDestinationSchema, rawText: z.string(), uploads: z.array(uploadSchema), status: z.enum(["preparing", "uncertain"]), createdAt: z.number(), error: z.string().optional() });

export type DraftDestination = z.infer<typeof draftDestinationSchema>;

export type DurableDraft = z.infer<typeof durableDraftSchema>;

export type DurableSubmission = z.infer<typeof durableSubmissionSchema>;

export interface DraftStorageIssue { kind: "draft" | "submission" | "attachment" | "storage"; id: string; message: string }

const storedDraftSchema = durableDraftSchema.omit({ uploads: true }).extend({ version: z.literal(2), uploadIds: z.array(z.string()) });

const storedSubmissionSchema = durableSubmissionSchema.omit({ uploads: true }).extend({ version: z.literal(2), uploadIds: z.array(z.string()) });

const storedAttachmentSchema = z.object({ id: z.string(), endpoint: z.string(), upload: uploadSchema });

const identitySchema = z.object({ id: z.string(), endpoint: z.string().optional(), destination: z.object({ endpoint: z.string() }).optional() });

const referenceSchema = z.object({ version: z.literal(2), uploadIds: z.array(z.string()) });

const versionSchema = z.object({ version: z.number() });

const endpointSchema = z.union([z.object({ endpoint: z.string() }), z.object({ destination: z.object({ endpoint: z.string() }) }).transform(record => ({ endpoint: record.destination.endpoint }))]);

export function draftEndpoint() {
  if (!isMobile) return "desktop";
  const connected = remoteClient.connectionIdentity();

  if (connected) return connected;

  try { return localStorage.getItem("piop-mobile-host") ?? "mobile"; }
  catch { return "mobile"; }
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
  const stored = storedDraftSchema.safeParse(input);
  let draft: DurableDraft;

  if (stored.success) draft = durableDraftSchema.parse({ ...stored.data, uploads: referencedUploads(stored.data.uploadIds, attachments) });
  else {
    if (versionSchema.safeParse(input).success) throw stored.error;
    draft = durableDraftSchema.parse(input);
  }

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
  const stored = storedSubmissionSchema.safeParse(input);

  if (stored.success) return durableSubmissionSchema.parse({ ...stored.data, uploads: referencedUploads(stored.data.uploadIds, attachments) });

  if (versionSchema.safeParse(input).success) throw stored.error;

  return durableSubmissionSchema.parse(input);
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

  private open() {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("piop-conversation-drafts", 2);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;

        if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });

        if (!database.objectStoreNames.contains("submissions")) database.createObjectStore("submissions", { keyPath: "id" });

        if (!database.objectStoreNames.contains("attachments")) database.createObjectStore("attachments", { keyPath: "id" }).createIndex("endpoint", "endpoint");
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
    const migrated: DurableDraft[] = [];

    for (const input of inputs) {
      const scope = recordScope(input, endpoint);

      if (!scope.belongs) continue;

      try {
        if (scope.damaged) throw new Error("Destination identity is missing");
        const draft = readDraft(input, attachments);
        drafts.push(draft);

        if (!referenceSchema.safeParse(input).success || !draft.text && !draft.uploads.length) migrated.push(draft);
      } catch (reason) { this.damagedDrafts.add(scope.id); issues.push(storageIssue("draft", scope.id, String(reason))); }
    }

    return { drafts, migrated };
  }

  private readSubmissions(inputs: z.JSONType[], endpoint: string, attachments: Map<string, z.infer<typeof uploadSchema>>, issues: DraftStorageIssue[]) {
    const submissions: DurableSubmission[] = [];
    const migrated: DurableSubmission[] = [];

    for (const input of inputs) {
      const scope = recordScope(input, endpoint);

      if (!scope.belongs) continue;

      try {
        if (scope.damaged) throw new Error("Destination identity is missing");
        const submission = readSubmission(input, attachments);
        submissions.push(submission);

        if (!referenceSchema.safeParse(input).success) migrated.push(submission);
      } catch (reason) { this.damagedSubmissions.add(scope.id); issues.push(storageIssue("submission", scope.id, String(reason))); }
    }

    return { submissions, migrated };
  }

  async load(endpoint: string) {
    const database = await this.open();

    const restored = await new Promise<{ drafts: DurableDraft[]; submissions: DurableSubmission[]; migratedDrafts: DurableDraft[]; migratedSubmissions: DurableSubmission[]; issues: DraftStorageIssue[] }>((resolve, reject) => {
      const transaction = database.transaction(["drafts", "submissions", "attachments"], "readonly");
      const drafts = transaction.objectStore("drafts").getAll();
      const submissions = transaction.objectStore("submissions").getAll();
      const uploads = transaction.objectStore("attachments").index("endpoint").getAll(endpoint);
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not read saved drafts"));
      transaction.oncomplete = () => {
        const issues: DraftStorageIssue[] = [];
        const attachments = this.readAttachments(uploads.result, issues);
        const restoredDrafts = this.readDrafts(drafts.result, endpoint, attachments, issues);
        const restoredSubmissions = this.readSubmissions(submissions.result, endpoint, attachments, issues);
        resolve({ drafts: restoredDrafts.drafts, submissions: restoredSubmissions.submissions, migratedDrafts: restoredDrafts.migrated, migratedSubmissions: restoredSubmissions.migrated, issues });
      };
    });

    try { await this.commit(restored.migratedDrafts, restored.migratedSubmissions); }
    catch (reason) { restored.issues.push(storageIssue("storage", "attachment migration", String(reason))); }

    return restored;
  }

  private stageUploads(store: IDBObjectStore, endpoint: string, uploads: DurableDraft["uploads"], staged: Set<string>) {
    return uploads.map(upload => {
      const id = attachmentId(endpoint, upload.id);

      if (staged.has(id)) return id;
      staged.add(id);
      const request = store.getKey(id);
      request.onsuccess = () => {
        if (request.result === undefined) { store.put({ id, endpoint, upload }); this.healthyAttachments.add(id); }
        else if (!this.healthyAttachments.has(id)) this.verifyAttachment(store, id);
      };

      return id;
    });
  }

  private verifyAttachment(store: IDBObjectStore, id: string) {
    const request = store.get(id);
    request.onsuccess = () => {
      try { readAttachment(request.result); this.healthyAttachments.add(id); }
      catch { store.transaction.abort(); }
    };
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

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["drafts", "submissions", "attachments"], "readwrite", { durability: "strict" });
      const draftStore = transaction.objectStore("drafts");
      const submissionStore = transaction.objectStore("submissions");
      const attachments = transaction.objectStore("attachments");
      const staged = new Set<string>();

      for (const draft of drafts) {
        const { uploads, ...record } = draft;

        if (!draft.text && !uploads.length) draftStore.delete(draft.id);
        else draftStore.put({ ...record, version: 2, uploadIds: this.stageUploads(attachments, draft.endpoint, uploads, staged) });
      }

      for (const submission of submissions) {
        const { uploads, ...record } = submission;
        submissionStore.put({ ...record, version: 2, uploadIds: this.stageUploads(attachments, submission.destination.endpoint, uploads, staged) });
      }

      for (const id of removeDrafts) draftStore.delete(id);

      for (const id of removeSubmissions) submissionStore.delete(id);
      cleanUnusedAttachments(transaction, this.healthyAttachments);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save draft content"));
    });
  }
}
