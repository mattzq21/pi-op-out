import { DatabaseSync as StorageDatabase } from "node:sqlite";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";
import { randomUUID as storageRandomId } from "node:crypto";
import { isDeepStrictEqual as sameStorageValue } from "node:util";
import { pathToFileURL as storageFileUrl } from "node:url";

import { storagePublish, storageTarget, requireStorageMethods } from "./storage-file.mjs";

const installedStorageClasses = new WeakSet();
let modelFileStorage;

export async function installRuntimeStorage(directory) {
  const modules = ["core/auth-storage.js", "core/settings-manager.js", "core/trust-manager.js", "utils/paths.js"];
  const [auth, settings, trust, paths] = await Promise.all(modules.map(file => import(storageFileUrl(storagePath.join(directory, "dist", file)).href)));
  modelFileStorage = auth.FileAuthStorageBackend;
  installAuthStorage(auth.FileAuthStorageBackend);
  installSettingsStorage(settings.FileSettingsStorage);
  installTrustStorage(trust.ProjectTrustStore, path => paths.canonicalizePath(paths.resolvePath(path)));
}

function sessionReferenceRoot() {
  return storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
}

export function storedModelText(path) {
  try { return storageFs.readFileSync(path, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function modelProviderData(body, parse) {
  const data = body ? parse(body) : {};

  if (!data || Object.getPrototypeOf(data) !== Object.prototype) throw new Error("Invalid saved provider settings");

  if (!Object.hasOwn(data, "providers")) data.providers = {};

  if (!data.providers || Object.getPrototypeOf(data.providers) !== Object.prototype) throw new Error("Invalid saved provider settings");

  return data;
}

export function saveStoredModelProvider(path, id, config, previous, parse) {
  return new modelFileStorage(path).withLock(body => {
    const data = modelProviderData(body, parse);
    const current = data.providers[id];

    if (previous === undefined && Object.hasOwn(data.providers, id)) throw new Error("That provider ID already exists");

    if (previous !== undefined && !sameStorageValue(current, previous)) throw new Error("Provider settings changed. Refresh before saving.");

    if (sameStorageValue(current, config)) return { result: true };
    Object.defineProperty(data.providers, id, { value: config, enumerable: true, writable: true, configurable: true });

    return { result: true, next: JSON.stringify(data, null, 2) };
  });
}

function publishAuthFile(path, body) {
  const target = storageTarget(path);
  const temporary = storagePath.join(storagePath.dirname(target), `.${storagePath.basename(target)}.${storageRandomId()}.tmp`);

  storagePublish(target, temporary, body, false);
}

/** The SDK writes auth.json and models.json in place; this keeps its lock and changes only the write. */
function installAuthStorage(FileAuthStorageBackend) {
  if (installedStorageClasses.has(FileAuthStorageBackend)) return;
  const prototype = FileAuthStorageBackend.prototype;
  requireStorageMethods(prototype, ["withLock", "withLockAsync"]);
  const withLock = prototype.withLock;
  const withLockAsync = prototype.withLockAsync;

  prototype.withLock = function (operation) {
    return withLock.call(this, current => {
      const { result, next } = operation(current);

      if (next !== undefined) publishAuthFile(this.authPath, next);

      return { result };
    });
  };

  prototype.withLockAsync = function (operation, options) {
    return withLockAsync.call(this, async current => {
      const { result, next } = await operation(current);

      options?.signal?.throwIfAborted();

      if (next !== undefined) publishAuthFile(this.authPath, next);

      return { result };
    }, options);
  };

  installedStorageClasses.add(FileAuthStorageBackend);
}

export function installSettingsStorage(FileSettingsStorage) {
  if (installedStorageClasses.has(FileSettingsStorage)) return;
  requireStorageMethods(FileSettingsStorage.prototype, ["withLock"]);

  FileSettingsStorage.prototype.withLock = function (scope, operation) {
    if (!["global", "project"].includes(scope)) throw new Error("Invalid settings scope");
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;

    return withStoredSettings(path, operation);
  };

  installedStorageClasses.add(FileSettingsStorage);
}

function trustDecisions(body) {
  const data = JSON.parse((body ?? "{}").replace(/^\uFEFF/, ""));

  if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.values(data).some(value => ![true, false, null].includes(value))) throw new Error("Invalid saved project trust decisions");

  return data;
}

function nearestTrustDecision(data, path) {
  for (let current = path; ; current = storagePath.dirname(current)) {
    const decision = data[current];

    if (decision === true || decision === false) return { path: current, decision };

    if (current === storagePath.dirname(current)) return null;
  }
}

function installTrustStorage(ProjectTrustStore, normalize) {
  if (installedStorageClasses.has(ProjectTrustStore)) return;
  requireStorageMethods(ProjectTrustStore.prototype, ["getEntry", "setMany"]);

  ProjectTrustStore.prototype.getEntry = function (cwd) {
    let entry;
    withStoredSettings(this.trustPath, body => {
      entry = nearestTrustDecision(trustDecisions(body), normalize(cwd));
    });

    return entry;
  };

  ProjectTrustStore.prototype.setMany = function (decisions) {
    withStoredSettings(this.trustPath, body => {
      const data = trustDecisions(body);

      for (const { path, decision } of decisions) {
        if (![true, false, null].includes(decision)) throw new Error("Invalid project trust decision");
        const key = normalize(path);

        if (decision === null) delete data[key];
        else data[key] = decision;
      }

      return JSON.stringify(data);
    });
  };

  installedStorageClasses.add(ProjectTrustStore);
}

function withStoredSettings(path, operation) {
  const root = sessionReferenceRoot();
  storageFs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = storagePath.join(root, "sessions.sqlite");
  if (storageFs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Database path must not be a symbolic link");
  const database = new StorageDatabase(file);
  const key = storagePath.resolve(path);

  try {
    storageFs.chmodSync(file, 0o600);
    database.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sdk_settings (path TEXT PRIMARY KEY, body TEXT);
      BEGIN IMMEDIATE;`);

    if (!database.prepare("SELECT 1 FROM sdk_settings WHERE path=?").get(key)) {
      database.prepare("INSERT INTO sdk_settings VALUES (?, ?)").run(key, null);
    }

    const current = database.prepare("SELECT body FROM sdk_settings WHERE path=?").get(key).body;
    const next = operation(current ?? undefined);

    if (next !== undefined) database.prepare("UPDATE sdk_settings SET body=? WHERE path=?").run(next, key);
    database.exec("COMMIT");
  } finally { database.close(); }
}
