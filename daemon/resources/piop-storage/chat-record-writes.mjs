import { isAbsolute } from "node:path";
import * as database from "../session-database.cjs";
import * as childIndex from "../session-broker/session-child-index.cjs";

// Small chat records that Pi asks the daemon to save through its storage channel.

function chatPath(root, value) {
  if (typeof value !== "string" || !isAbsolute(value) || !value.endsWith(".jsonl") || value.includes("\0")) throw new Error("Invalid transcript path");
  if (database.storageRoot(value) !== root) throw new Error("This chat is not in the storage of this Pi");
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${name}`);
  return value;
}

export const OPERATIONS = {
  // Starts the index of a chat's side chats, reviews and subagents when the chat is new or had one.
  initializeChildren: async (root, request) => {
    await childIndex.initialize(chatPath(root, request?.path), text(request.sessionId, "session ID"), request.fresh === true);
    return null;
  },
  // The chat list summary of one transcript, kept until the transcript changes.
  saveSummary: (root, request) => {
    const path = chatPath(root, request?.path);
    if (!request.value || typeof request.value !== "object") throw new Error("Invalid chat summary");
    const stamp = text(request.stamp, "summary stamp");
    database.saveSdkSessionSummary(root, text(request.sessionId, "session ID"), path, stamp, JSON.stringify(request.value));
    return null;
  },
};
