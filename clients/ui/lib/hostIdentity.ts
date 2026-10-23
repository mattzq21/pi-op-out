export function hostIdentity(name: string) {
  const normalized = name.trim().toLowerCase();

  if (!normalized) throw new Error("Enter a host name");

  return `host:${encodeURIComponent(normalized)}`;
}
