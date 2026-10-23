import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function readDaemonEndpoint(directory, name = "daemon.json") {
  let database;

  try {
    database = new DatabaseSync(join(directory, "sessions.sqlite"), { readOnly: true });
    database.exec("PRAGMA busy_timeout=2000");

    const row = database.prepare("SELECT body FROM application_settings WHERE name=?").get(name);

    return row?.body ? JSON.parse(Buffer.from(row.body).toString("utf8")) : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}
