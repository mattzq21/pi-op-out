import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { runGit } from "./git.ts";
import { checkpointSchema, pendingCheckpointSchema, type PromptCheckpoint } from "./schemas.ts";

type CheckpointHistory = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

type ResolveCommit = (root: string, owner: string, key: string) => Promise<string | undefined>;

type PromptCheckpointRequest = { key: string; repositoryRoot: string; capturedAt: string };

const PROMPT_ENTRY = "pi-project-prompt-checkpoint";

function completedCheckpoints(entries: CheckpointHistory) {
  const completed = new Map<string, PromptCheckpoint>();

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === PROMPT_ENTRY && Check(checkpointSchema, entry.data)) completed.set(entry.data.key, entry.data);
  }

  return completed;
}

async function recoverCheckpoint(pending: PromptCheckpointRequest, owner: string, resolveCommit: ResolveCommit, sourceOwner?: string): Promise<PromptCheckpoint | undefined> {
  const root = pending.repositoryRoot;

  const commit = await resolveCommit(root, owner, pending.key)
    ?? (sourceOwner ? await resolveCommit(root, sourceOwner, pending.key) : undefined);

  if (!commit) return undefined;
  const [, parent] = (await runGit(root, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/);

  return { key: pending.key, owner: sourceOwner ?? owner, repositoryRoot: root, capturedAt: pending.capturedAt, commit, base: parent ?? null };
}

export async function resolvePromptHistory(history: CheckpointHistory, entries: CheckpointHistory, owner: string, resolveCommit: ResolveCommit, sourceOwner?: string): Promise<CheckpointHistory> {
  const completed = completedCheckpoints(entries);
  const resolved: CheckpointHistory = [];

  for (const entry of history) {
    if (entry.type !== "custom" || entry.customType !== PROMPT_ENTRY || !Check(pendingCheckpointSchema, entry.data)) { resolved.push(entry); continue; }

    const checkpoint = completed.get(entry.data.key) ?? await recoverCheckpoint(entry.data, owner, resolveCommit, sourceOwner);

    resolved.push({ ...entry, data: checkpoint ? { ...checkpoint, background: false } : { unavailable: true } });
  }

  return resolved;
}

export function recordRecoveredCheckpoints(pi: ExtensionAPI, history: CheckpointHistory, entries: CheckpointHistory) {
  const completed = completedCheckpoints(entries);

  for (const entry of history) {
    if (entry.type !== "custom" || entry.customType !== PROMPT_ENTRY || !Check(checkpointSchema, entry.data) || completed.has(entry.data.key)) continue;
    pi.appendEntry(PROMPT_ENTRY, { ...entry.data, background: true });
    completed.set(entry.data.key, entry.data);
  }
}
