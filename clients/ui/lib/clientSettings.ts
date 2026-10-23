import type { AppSettings } from "../types";
import { invoke } from "./platform";
import { z } from "zod";
import { settingsPublicationSchema } from "./responseSchemas";
import { applyClientPreferences, clientPreferences, clientPreferencesSchema, ClientPreferenceConflictError } from "./clientPreferenceMerge";

const storageKey = "piop-client-settings";

let durabilityFailure: { revision: string; error: string } | undefined;

const coreClientSettingsSchema = z.object({
  keybindings: z.record(z.string(), z.string()).optional().catch(undefined),
  debugMode: z.boolean().optional().catch(undefined),
  debugFeaturesOff: z.array(z.string()).optional().catch(undefined),
}).catch({});

const clientSettingsSchema = coreClientSettingsSchema;

type StoredPreferences = z.infer<typeof clientSettingsSchema>;

async function storedPreferences(): Promise<{ settings: StoredPreferences; persisted: boolean; revision: string }> {
  const stored = await invoke("load_client_settings", undefined, z.object({ settings: clientSettingsSchema.nullable(), revision: z.string() }));

  if (stored.settings) return { settings: stored.settings, persisted: true, revision: stored.revision };

  try { return { settings: clientSettingsSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "null")), persisted: false, revision: stored.revision }; } catch { return { settings: {}, persisted: false, revision: stored.revision }; }
}

export async function withClientSettings(source: AppSettings | Promise<AppSettings>, migrate = false): Promise<AppSettings> {
  const [settings, preferences] = await Promise.all([source, storedPreferences()]);
  const merged = { ...mergeClientSettings(settings, preferences.settings), ...clientRevision(preferences.revision) };

  if (migrate && !preferences.persisted) return saveClientSettings(merged, settings, true);

  return merged;
}

function mergeClientSettings(settings: AppSettings, stored: StoredPreferences): AppSettings {
  return { ...settings,
    keybindings: stored.keybindings ? { ...settings.keybindings, ...stored.keybindings } : settings.keybindings,
    debugMode: stored.debugMode ?? settings.debugMode,
    debugFeaturesOff: stored.debugFeaturesOff ?? settings.debugFeaturesOff ?? [],
  };
}

export async function saveClientSettings(settings: AppSettings, baseline: AppSettings, initialize = false): Promise<AppSettings> {
  let stored;

  try { stored = await invoke("save_client_settings", { settings: clientPreferences(settings), baseline: clientPreferences(baseline), initialize }, z.object({ settings: clientPreferencesSchema, revision: z.string(), publication: settingsPublicationSchema })); }
  catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);

    if (!message.includes("Client preference conflict at ")) throw reason;
    let latest: AppSettings | undefined;

    try { latest = await withClientSettings(baseline); } catch { }

    throw new ClientPreferenceConflictError(message, latest);
  }

  const error = publicationError(stored.publication);
  durabilityFailure = error ? { revision: stored.revision, error } : undefined;

  if (!error) { try { localStorage.removeItem(storageKey); } catch { } }

  return { ...applyClientPreferences(settings, stored.settings), ...clientRevision(stored.revision) };
}

export function preserveDaemonPreferences(settings: AppSettings, daemonSettings: AppSettings): AppSettings {
  return { ...settings, ...clientPreferences(daemonSettings), keybindings: { ...daemonSettings.keybindings }, clientSettingsRevision: daemonSettings.clientSettingsRevision, clientSettingsDurabilityError: daemonSettings.clientSettingsDurabilityError };
}

function clientRevision(revision: string): Pick<AppSettings, "clientSettingsRevision" | "clientSettingsDurabilityError"> {
  return { clientSettingsRevision: revision, clientSettingsDurabilityError: durabilityFailure?.revision === revision ? durabilityFailure.error : undefined };
}

function publicationError(publication: z.infer<typeof settingsPublicationSchema>) {
  return publication.durable ? undefined : publication.error ?? "Disk durability could not be confirmed.";
}
