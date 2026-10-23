/**
 * Top-level app settings fields that a plugin owns. They are saved with the app settings whether the plugin is enabled or not,
 * so turning a plugin off and on keeps them.
 */
export interface SettingsContribution<T extends object> {
  /** The fields in saved order. */
  fields: readonly (keyof T & string)[];
  defaults(): T;
  /** Reads the fields from saved settings, with defaults for missing ones. Throws on a field of the wrong type. */
  parse(value: Record<string, unknown>): T;
}

/** A saved string setting, or the fallback when it is missing. */
export function stringSetting(value: unknown, field: string, fallback: () => string): string {
  if (value === undefined) return fallback();
  if (typeof value !== 'string') throw new Error(`invalid type for ${field}: expected a string`);
  return value;
}
