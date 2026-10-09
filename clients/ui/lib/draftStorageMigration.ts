export function upgradeDraftStorage(database: IDBDatabase, transaction: IDBTransaction) {
  if (database.objectStoreNames.contains("drafts")) {
    const drafts = transaction.objectStore("drafts");

    if (drafts.keyPath !== "id") throw new Error("Unsupported draft database format");
  }

  if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });

  if (!database.objectStoreNames.contains("submissions")) database.createObjectStore("submissions", { keyPath: "id" });

  if (!database.objectStoreNames.contains("attachments")) database.createObjectStore("attachments", { keyPath: "id" }).createIndex("endpoint", "endpoint");

}
