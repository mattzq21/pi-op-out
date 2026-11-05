import * as publication from "./session-publication.cjs";
import * as goalAssets from "./goal-assets.cjs";
import * as auxiliaryCopies from "./auxiliary-copies.cjs";
import { acquireReferencePublicationLockAsync } from "./reference-publication-lock.cjs";
import * as registry from "../session-registry.cjs";
import { validateSessionReferencePublication } from "./transcript-file.mjs";
import * as storagePath from "node:path";

// The new chats that Pi extensions make: forks, side chats, reviews, subagent and peer chats. Only the daemon runs these:
// Pi sends each one through its storage channel. A chat that waits for its parent's link keeps its claim until the Pi
// that made it acknowledges or releases it, or until that Pi's channel closes.

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function transcriptPath(value) {
  if (typeof value !== "string" || !storagePath.isAbsolute(value) || !value.endsWith(".jsonl") || value.includes("\0")) throw new Error("Invalid transcript path");
  return value;
}

function sameRoot(root, value) {
  if (value !== root) throw new Error("This chat is not in the storage of this Pi");
  return root;
}

function handle(root, value) {
  const item = object(value, "chat publication");
  if (typeof item.id !== "string" || !UUID.test(item.id)) throw new Error("Invalid chat publication");
  return { id: item.id, root: sameRoot(root, item.root), sessionPath: transcriptPath(item.sessionPath), warnings: [] };
}

function options(value) {
  const given = value === undefined ? {} : object(value, "publication options");
  const unknown = Object.keys(given).filter(key => !["name", "link", "dependencies", "goalSource"].includes(key));
  if (unknown.length) throw new Error(`Unknown publication options: ${unknown.join(", ")}`);
  if (given.goalSource !== undefined) transcriptPath(given.goalSource);
  return given;
}

// Saves a new chat transcript with its records, as one publication.
export function writeSessionFile(root, path, entries, given) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("Invalid transcript entries");
  const body = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  return publication.publish(transcriptPath(path), body, async operation => {
    const release = await acquireReferencePublicationLockAsync(root);
    try {
      registry.registerExternalTranscript(root, path);
      validateSessionReferencePublication(entries, undefined, root);
      return await operation();
    } finally { release(); }
  }, options(given));
}

function claimed(owner, result) {
  if (result?.id && owner) owner.claims.add(result.id);
  return result;
}

// The changes that take the goal asset lock first.
export const GOAL_ASSETS_LOCKED = new Set(["retainHistory", "releaseHistory"]);

export const OPERATIONS = {
  publish: (root, request, owner) => writeSessionFile(root, request?.path, request?.entries, request?.options).then(result => claimed(owner, result)),
  acknowledge: async (root, request, owner) => {
    const item = handle(root, request);
    try { return await publication.acknowledge(item); } finally { owner?.claims.delete(item.id); }
  },
  release: (root, request, owner) => {
    const item = handle(root, request);
    publication.release(item);
    owner?.claims.delete(item.id);
    return null;
  },
  pendingLinks: async (root, request, owner) => {
    const item = object(request, "pending link request");
    const pending = await publication.pendingLinks(transcriptPath(item.parentPath), String(item.parentId), String(item.kind));
    for (const { publication: claim } of pending) claimed(owner, claim);
    return pending;
  },
  retainHistory: (root, request) => goalAssets.retainHistory(sameRoot(root, request?.root), request.entries, String(request.sessionId), transcriptPath(request.sessionPath)),
  releaseHistory: (root, request) => { goalAssets.releaseHistory(sameRoot(root, request?.root), object(request.contract, "goal asset contract"), String(request.sessionId)); return null; },
  publishCopies: async (root, request) => {
    await auxiliaryCopies.publishAuxiliaryCopies(sameRoot(root, request?.root), object(request.plan, "copy plan"), object(request.target, "copy target"),
      (path, entries, given) => writeSessionFile(root, path, entries, given));
    return null;
  },
};

// Gives back the claims of a Pi whose channel closed.
export function releaseClaims(root, owner) {
  for (const id of owner.claims) publication.release({ id, root });
  owner.claims.clear();
}
