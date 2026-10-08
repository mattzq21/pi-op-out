import { z } from "zod";
import { imageAttachmentSchema } from "./responseSchemas";
import { nativeConnectionTargetSchema } from "./sessionResume";
import type { DraftStorageIssue, DurableDraft } from "./draftStorage";

const legacyUploadSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), name: z.string(), byteSize: z.number().nonnegative(), kind: z.literal("image"), image: imageAttachmentSchema }),
  z.object({ id: z.string(), name: z.string(), byteSize: z.number().nonnegative(), kind: z.literal("text"), text: z.string() }),
]);

const legacyDraftSchema = z.object({ namespace: z.string(), key: z.string(), revision: z.string(), text: z.string(), uploads: z.array(legacyUploadSchema), target: nativeConnectionTargetSchema.optional(), updatedAt: z.number() });

function convertedDraft(record: z.infer<typeof legacyDraftSchema>): DurableDraft {
  const target = record.target;
  const endpoint = record.namespace;
  const key = record.key;
  const hostId = target?.hostId ?? key.slice(0, key.lastIndexOf(":"));
  const destination = target && hostId && key.startsWith(`${hostId}:`) ? { key, endpoint, hostId, cwd: target.cwd, sessionPath: target.sessionPath, temporary: !target.cwd && !target.sessionPath } : undefined;

  return { id: JSON.stringify([endpoint, key]), endpoint, key, destination, text: record.text, uploads: record.uploads, updatedAt: record.updatedAt };
}

function migrateLegacyDrafts(legacy: IDBObjectStore, drafts: IDBObjectStore) {
  const request = legacy.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;

    if (!cursor) return;
    const parsed = legacyDraftSchema.safeParse(cursor.value);

    if (!parsed.success) { cursor.continue();

      return; }

    const draft = convertedDraft(parsed.data);
    const existing = drafts.getKey(draft.id);
    existing.onsuccess = () => {
      if (existing.result === undefined) {
        drafts.add({ ...draft, revision: parsed.data.revision });
        cursor.delete();
      }

      cursor.continue();
    };
  };
}

export function upgradeDraftStorage(database: IDBDatabase, transaction: IDBTransaction) {
  if (database.objectStoreNames.contains("drafts")) {
    const drafts = transaction.objectStore("drafts");

    if (JSON.stringify(drafts.keyPath) === JSON.stringify(["namespace", "key"])) drafts.name = "legacyDrafts";
    else if (drafts.keyPath !== "id") throw new Error("The saved draft database has an unsupported identity format");
  }

  if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });

  if (!database.objectStoreNames.contains("submissions")) database.createObjectStore("submissions", { keyPath: "id" });

  if (!database.objectStoreNames.contains("attachments")) database.createObjectStore("attachments", { keyPath: "id" }).createIndex("endpoint", "endpoint");

  if (database.objectStoreNames.contains("legacyDrafts")) migrateLegacyDrafts(transaction.objectStore("legacyDrafts"), transaction.objectStore("drafts"));
}

export function legacyDraftIssues(inputs: z.JSONType[], endpoint: string): DraftStorageIssue[] {
  return inputs.flatMap(input => {
    const identity = z.object({ namespace: z.string(), key: z.string() }).safeParse(input);

    if (identity.success && identity.data.namespace !== endpoint) return [];

    return [{ kind: "storage", id: identity.success ? identity.data.key : "legacy draft", message: "An older saved draft could not be migrated. Its original record has been retained in the draft database." }];
  });
}
