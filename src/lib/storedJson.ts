import type { z } from "zod";

export function readStoredJson<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    return schema.parse(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return fallback;
  }
}
