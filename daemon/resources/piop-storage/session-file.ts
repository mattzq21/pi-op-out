import { call } from "../storage-channel.cjs";

// New chats that a Pi extension makes. The daemon saves each with all that belongs to it, or nothing: each call goes
// through the storage channel and waits for the answer.

export interface NewChat {
  path: string;
  // The header first. Its ID must be reserved and end the path.
  entries: unknown[];
  name?: string;
  // The ID of the chat whose goal the new chat gets.
  goalSource?: string;
}

export async function createChat(chat: NewChat): Promise<void> {
  call("chats.create", chat);
}

// Saves a fork of the chat source, with copies of the side chats, reviews and subagents that source had at cutoff.
export async function createFork(fork: NewChat & { source: string; cutoff?: string }): Promise<void> {
  call("chats.fork", fork);
}

export { reserveSessionId } from "./identities.mjs";
