import type { AppSettings } from "../types";

export function modelChoiceId(provider: string, id: string) { return `${provider}/${id}`; }

export function mergeModelIds(latest: readonly string[] | undefined, baseline: readonly string[] | undefined, intended: readonly string[] | undefined) {
  if (latest === undefined && intended === undefined) return undefined;
  const before = new Set(baseline);
  const after = new Set(intended);
  const merged = new Set((latest ?? []).filter(id => !before.has(id) || after.has(id)));

  for (const id of intended ?? []) if (!before.has(id)) merged.add(id);

  return [...merged];
}

export function recordSeenModels(settings: AppSettings, ids: string[]): AppSettings | undefined {
  if (settings.knownModels === undefined) return { ...settings, knownModels: [...new Set(ids)] };
  const known = new Set(settings.knownModels);
  const fresh = [...new Set(ids)].filter((id) => !known.has(id));

  if (fresh.length === 0) return undefined;
  const hidden = new Set(settings.hiddenModels);

  for (const id of fresh) hidden.add(id);

  return { ...settings, knownModels: [...settings.knownModels, ...fresh], hiddenModels: [...hidden] };
}
