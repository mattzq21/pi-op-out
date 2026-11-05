import * as storageDatabase from '../session-database/index.ts';
import * as storageFs from "node:fs";
import * as storagePath from "node:path";
import { homedir as storageHome } from "node:os";
import { isDeepStrictEqual as sameStorageValue } from "node:util";
import { pathToFileURL as storageFileUrl } from "node:url";

import type * as PiAuthStorage from '@earendil-works/pi-coding-agent/dist/core/auth-storage.js';
import type * as PiSettingsManager from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import type * as PiTrustManager from '@earendil-works/pi-coding-agent/dist/core/trust-manager.js';
import type { ProjectTrustStoreEntry } from '@earendil-works/pi-coding-agent/dist/core/trust-manager.js';
import type * as PiPaths from '@earendil-works/pi-coding-agent/dist/utils/paths.js';
import { patchMethod, requireMethods } from '../pi/index.ts';
import { storageChannel } from '../session-database/index.ts';

// Pi keeps reading its settings and sign-in files itself. It asks the daemon to save each change, through its storage channel.

const installedStorageClasses = new WeakSet();
let modelFileStorage!: typeof PiAuthStorage.FileAuthStorageBackend;

type ParseModels = (body: string) => unknown;

type TrustDecisions = Record<string, boolean | null>;

export async function installRuntimeStorage(directory: string) {
  const load = (file: string) => import(storageFileUrl(storagePath.join(directory, "dist", file)).href);
  const [auth, settings, trust, paths]: [typeof PiAuthStorage, typeof PiSettingsManager, typeof PiTrustManager, typeof PiPaths] = await Promise.all([load("core/auth-storage.js"), load("core/settings-manager.js"), load("core/trust-manager.js"), load("utils/paths.js")]);
  modelFileStorage = auth.FileAuthStorageBackend;
  installAuthStorage(auth.FileAuthStorageBackend);
  installSettingsStorage(settings.FileSettingsStorage);
  installTrustStorage(trust.ProjectTrustStore, path => paths.canonicalizePath(paths.resolvePath(path)));
}

function sessionReferenceRoot() {
  return storagePath.join(storageHome(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");
}

export function storedModelText(path: string): string | undefined {
  try { return storageFs.readFileSync(path, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function plainStorageObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function modelProviderData(body: string | undefined, parse: ParseModels) {
  const data = body ? parse(body) : {};

  if (!plainStorageObject(data)) throw new Error("Invalid saved provider settings");

  if (!Object.hasOwn(data, "providers")) data.providers = {};
  const providers = data.providers;

  if (!plainStorageObject(providers)) throw new Error("Invalid saved provider settings");

  return { data, providers };
}

export function saveStoredModelProvider(path: string, id: string, config: unknown, previous: unknown, parse: ParseModels): boolean {
  return new modelFileStorage(path).withLock(body => {
    const { data, providers } = modelProviderData(body, parse);
    const current = providers[id];

    if (previous === undefined && Object.hasOwn(providers, id)) throw new Error("That provider ID already exists");

    if (previous !== undefined && !sameStorageValue(current, previous)) throw new Error("Provider settings changed. Refresh before saving.");

    if (sameStorageValue(current, config)) return { result: true };
    Object.defineProperty(providers, id, { value: config, enumerable: true, writable: true, configurable: true });

    return { result: true, next: JSON.stringify(data, null, 2) };
  });
}

export function removeStoredModelProvider(path: string, id: string, parse: ParseModels): boolean {
  return new modelFileStorage(path).withLock(body => {
    const { data, providers } = modelProviderData(body, parse);

    if (!Object.hasOwn(providers, id)) throw new Error("That provider is not a custom provider");
    delete providers[id];

    return { result: true, next: JSON.stringify(data, null, 2) };
  });
}

function readPiFile(path: string): string | undefined {
  try { return storageFs.readFileSync(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function publishPiFile(path: string, body: string) {
  storageChannel.call("settings.publishFile", { path: storagePath.resolve(path), body });
}

// Pi's sign-in, model and MCP sign-in files. Pi still takes its own lock on the file, so a sign-in refresh in one Pi
// waits for the one in another. The daemon writes the file; a missing file reads as empty and is not made.
function installAuthStorage(FileAuthStorageBackend: typeof PiAuthStorage.FileAuthStorageBackend) {
  if (installedStorageClasses.has(FileAuthStorageBackend)) return;
  const prototype = FileAuthStorageBackend.prototype;
  requireMethods(prototype, ["withLock", "withLockAsync", "acquireLockSyncWithRetry", "acquireLockAsync"]);

  patchMethod(prototype, "withLock", () => function (this: any, operation) {
    const release = this.acquireLockSyncWithRetry(this.authPath);

    try {
      const { result, next } = operation(readPiFile(this.authPath));

      if (next !== undefined) publishPiFile(this.authPath, next);

      return result;
    } finally { release(); }
  });

  patchMethod(prototype, "withLockAsync", () => async function (this: any, operation, options) {
    options?.signal?.throwIfAborted();
    let compromised: Error | undefined;
    const release = await this.acquireLockAsync(options?.signal, (error?: Error) => { compromised = error ?? new Error("Auth storage lock was compromised"); });
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

export function installSettingsStorage(FileSettingsStorage: typeof PiSettingsManager.FileSettingsStorage) {
  if (installedStorageClasses.has(FileSettingsStorage)) return;
  patchMethod(FileSettingsStorage.prototype, "withLock", () => function (this: any, scope, operation) {
    if (!["global", "project"].includes(scope)) throw new Error("Invalid settings scope");
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;

    return withStoredSettings(path, operation);
  });

  installedStorageClasses.add(FileSettingsStorage);
}

function validTrustDecisions(value: unknown): value is TrustDecisions {
  return plainStorageObject(value) && !Object.values(value).some(decision => ![true, false, null].includes(decision as boolean | null));
}

function trustDecisions(body: string | undefined): TrustDecisions {
  const data: unknown = JSON.parse((body ?? "{}").replace(/^\uFEFF/, ""));

  if (!validTrustDecisions(data)) throw new Error("Invalid saved project trust decisions");

  return data;
}

function nearestTrustDecision(data: TrustDecisions, path: string): ProjectTrustStoreEntry | null {
  for (let current = path; ; current = storagePath.dirname(current)) {
    const decision = data[current];

    if (decision === true || decision === false) return { path: current, decision };

    if (current === storagePath.dirname(current)) return null;
  }
}

function installTrustStorage(ProjectTrustStore: typeof PiTrustManager.ProjectTrustStore, normalize: (path: string) => string) {
  if (installedStorageClasses.has(ProjectTrustStore)) return;
  requireMethods(ProjectTrustStore.prototype, ["getEntry", "setMany"]);

  patchMethod(ProjectTrustStore.prototype, "getEntry", () => function (this: any, cwd) {
    let entry: ProjectTrustStoreEntry | null | undefined;
    withStoredSettings(this.trustPath, body => {
      entry = nearestTrustDecision(trustDecisions(body), normalize(cwd));
    });

    return entry;
  });

  patchMethod(ProjectTrustStore.prototype, "setMany", () => function (this: any, decisions) {
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
function withStoredSettings(path: string, operation: (current: string | undefined) => string | undefined | void): void {
  const key = storagePath.resolve(path);

  for (let attempt = 1; ; attempt++) {
    const current = storageDatabase.sdkSettingsText(sessionReferenceRoot(), key);
    const next = operation(current);

    if (next === undefined || storageChannel.call("settings.replace", { path: key, previous: current ?? null, next })) return;

    if (attempt === 20) throw new Error("Pi settings kept changing while they were saved. Try again.");
  }
}
