export { reserveSessionId } from "./identities.mjs";
import { call } from "../storage-channel.cjs";

// New chats that a Pi extension makes. The daemon saves them: each call goes through the storage channel and waits for the answer.

export interface SessionPublication { id: string; root: string; sessionPath: string; warnings: string[] }

export interface PublicationOptions {
  name?: string;
  // The parent's record that links to this chat. The chat keeps its claim until it is acknowledged or released.
  link?: { record: Record<string, unknown> & { kind: string; sessionId: string; parentSessionId: string; publicationId: string }; parentSessionPath: string; message: { customType: string; content: string } };
  dependencies?: { workspace?: { path: string; kind: "existing" | "created-directory" } };
  // The chat whose goal record the new chat gets.
  goalSource?: string;
}

// Saving the chat failed, but its goal and folder dependencies are kept for recovery.
export function publicationRetainsDependencies(error: Error): boolean {
  const flags = error as Error & { dependenciesRetained?: boolean; publicationPending?: boolean };
  if (flags.dependenciesRetained === true || flags.publicationPending === true) return true;

  return error.cause instanceof Error && publicationRetainsDependencies(error.cause);
}

export async function writeSessionFile(path: string, entries: unknown[], options?: PublicationOptions): Promise<SessionPublication> {
  return await call("publication.publish", { path, entries, options }) as SessionPublication;
}

// Saves the parent's link to a new chat. False when the link is not saved yet.
export async function acknowledge(publication: SessionPublication): Promise<boolean> {
  return await call("publication.acknowledge", publication) === true;
}

export function release(publication: SessionPublication): void {
  call("publication.release", publication);
}

// The new chats of one kind whose link to this parent is not saved yet. This Pi holds their claims until it releases them.
export async function pendingLinks(parentPath: string, parentId: string, kind: string): Promise<Array<{ publication: SessionPublication; record: unknown }>> {
  return await call("publication.pendingLinks", { parentPath, parentId, kind }) as Array<{ publication: SessionPublication; record: unknown }>;
}

export interface GoalAssetContract { version: 1; policy: string; directories: Array<{ path: string; identity: unknown }> }

// Marks the goal folders of a chat's history as also used by a new chat.
export function retainHistory(root: string, entries: unknown[], sessionId: string, sessionPath: string): GoalAssetContract {
  return call("publication.retainHistory", { root, entries, sessionId, sessionPath }) as GoalAssetContract;
}

export function releaseHistory(root: string, contract: GoalAssetContract, sessionId: string): void {
  call("publication.releaseHistory", { root, contract, sessionId });
}

// Saves the side chats, reviews and subagent chats of a fork, and their subagent runs.
export async function publishAuxiliaryCopies(root: string, plan: unknown, target: { id: string }): Promise<void> {
  await call("publication.publishCopies", { root, plan, target });
}
