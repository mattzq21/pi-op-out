export { reserveSessionId } from "./identities.mjs";
import { acquireSessionReferencePublication, validateSessionReferencePublication } from "./session-storage.mjs";
import { publish, SessionPublicationError, type PublicationOptions } from "./session-publication.cjs";

export type { PublicationOptions, SessionPublication } from "./session-publication.cjs";

export function publicationRetainsDependencies(error: Error): boolean {
  if (error instanceof SessionPublicationError) return error.dependenciesRetained || error.publicationPending;

  return error.cause instanceof Error && publicationRetainsDependencies(error.cause);
}

export async function writeSessionFile(path: string, entries: unknown[], options?: PublicationOptions) {
  return await publish(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", async operation => {
    const release = acquireSessionReferencePublication(path);

    try {
      validateSessionReferencePublication(entries);

      return await operation();
    } finally { release(); }
  }, options);
}

