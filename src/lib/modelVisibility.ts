import type { AppSettings } from "../types";

export function modelChoiceId(provider: string, id: string) { return `${provider}/${id}`; }

// Records which models have been seen so newly arrived models can stay
// hidden until explicitly enabled. The configured default model is exempt.
// Returns updated settings, or undefined when nothing changed.
export function recordSeenModels(settings: AppSettings, ids: string[]): AppSettings | undefined {
  if (settings.knownModels === undefined) return { ...settings, knownModels: ids };
  const known = new Set(settings.knownModels);
  const fresh = ids.filter((id) => !known.has(id) && id !== settings.defaultModel);
  if (fresh.length === 0) return undefined;
  const hidden = new Set(settings.hiddenModels);
  for (const id of fresh) hidden.add(id);
  return { ...settings, knownModels: [...settings.knownModels, ...fresh], hiddenModels: [...hidden] };
}
