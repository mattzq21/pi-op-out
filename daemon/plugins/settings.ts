// A plugin's own settings, saved under its plugin ID.
export interface SettingsContribution<T extends Record<string, unknown>> {
  defaults(): T;
  parse(value: Record<string, unknown>): T;
}

export function stringSetting(value: unknown, field: string, fallback: () => string): string {
  if (value === undefined) return fallback();
  if (typeof value !== 'string') throw new Error(`invalid type for ${field}: expected a string`);
  return value;
}
