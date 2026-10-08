import { publish, SessionPublicationError, type PublicationOptions } from "./session-publication.cjs";

export type { PublicationOptions, SessionPublication } from "./session-publication.cjs";

export function publicationRetainsDependencies(error: Error): boolean {
  if (error instanceof SessionPublicationError) return error.dependenciesRetained || error.publicationPending;

  return error.cause instanceof Error && publicationRetainsDependencies(error.cause);
}

export async function writeSessionFile(path: string, entries: unknown[], options?: PublicationOptions) {
  return publish(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", options);
}
