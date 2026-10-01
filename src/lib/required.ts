export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required value is unavailable");

  return value;
}
