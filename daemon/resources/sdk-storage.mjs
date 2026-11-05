import * as storageDatabase from "./session-database.cjs";
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";
import { isDeepStrictEqual as sameStorageValue } from "node:util";
import { pathToFileURL as storageFileUrl } from "node:url";

import { patchMethod, requireMethods } from "./pi-patch.cjs";
import { call } from "./storage-channel.cjs";

// Pi keeps reading its settings and sign-in files itself. It asks the daemon to save each change, through its storage channel.

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

export function removeStoredModelProvider(path, id, parse) {
  return new modelFileStorage(path).withLock(body => {
    const data = modelProviderData(body, parse);

    if (!Object.hasOwn(data.providers, id)) throw new Error("That provider is not a custom provider");
    delete data.providers[id];

    return { result: true, next: JSON.stringify(data, null, 2) };
  });
}

function readPiFile(path) {
  try { return storageFs.readFileSync(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function publishPiFile(path, body) {
  call("settings.publishFile", { path: storagePath.resolve(path), body });
}

// Pi's sign-in, model and MCP sign-in files. Pi still takes its own lock on the file, so a sign-in refresh in one Pi
// waits for the one in another. The daemon writes the file; a missing file reads as empty and is not made.
function installAuthStorage(FileAuthStorageBackend) {
  if (installedStorageClasses.has(FileAuthStorageBackend)) return;
  const prototype = FileAuthStorageBackend.prototype;
  requireMethods(prototype, ["withLock", "withLockAsync", "acquireLockSyncWithRetry", "acquireLockAsync"]);

  patchMethod(prototype, "withLock", () => function (operation) {
    const release = this.acquireLockSyncWithRetry(this.authPath);

    try {
      const { result, next } = operation(readPiFile(this.authPath));

      if (next !== undefined) publishPiFile(this.authPath, next);

      return result;
    } finally { release(); }
  });

  patchMethod(prototype, "withLockAsync", () => async function (operation, options) {
    options?.signal?.throwIfAborted();
    let compromised;
    const release = await this.acquireLockAsync(options?.signal, error => { compromised = error ?? new Error("Auth storage lock was compromised"); });
    const check = () => { if (compromised) throw compromised; options?.signal?.throwIfAborted(); };

    try {
      check();
      const { result, next } = await operation(readPiFile(this.authPath));
      check();

      if (next !== undefined) publishPiFile(this.authPath, next);

      return result;
    } finally { await release().catch(() => {}); }
  });

  installedStorageClasses.add(FileAuthStorageBackend);
}

export function installSettingsStorage(FileSettingsStorage) {
  if (installedStorageClasses.has(FileSettingsStorage)) return;
  patchMethod(FileSettingsStorage.prototype, "withLock", () => function (scope, operation) {
    if (!["global", "project"].includes(scope)) throw new Error("Invalid settings scope");
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;

    return withStoredSettings(path, operation);
  });

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
  requireMethods(ProjectTrustStore.prototype, ["getEntry", "setMany"]);

  patchMethod(ProjectTrustStore.prototype, "getEntry", () => function (cwd) {
    let entry;
    withStoredSettings(this.trustPath, body => {
      entry = nearestTrustDecision(trustDecisions(body), normalize(cwd));
    });

    return entry;
  });

  patchMethod(ProjectTrustStore.prototype, "setMany", () => function (decisions) {
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
  });

  installedStorageClasses.add(ProjectTrustStore);
}

// Settings and trust changes are pure changes of the saved text. When another process saved first, the change runs again on its text.
function withStoredSettings(path, operation) {
  const key = storagePath.resolve(path);

  for (let attempt = 1; ; attempt++) {
    const current = storageDatabase.sdkSettingsText(sessionReferenceRoot(), key);
    const next = operation(current);

    if (next === undefined || call("settings.replace", { path: key, previous: current ?? null, next })) return;

    if (attempt === 20) throw new Error("Pi settings kept changing while they were saved. Try again.");
  }
}
