export interface SettingsContribution<T extends object> {
  fields: readonly (keyof T & string)[];
  defaults(): T;
  parse(value: Record<string, unknown>): T;
}

export function stringSetting(value: unknown, field: string, fallback: () => string): string {
  if (value === undefined) return fallback();
  if (typeof value !== 'string') throw new Error(`invalid type for ${field}: expected a string`);
  return value;
}
