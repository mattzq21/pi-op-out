import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { checkpointSchema, type PromptCheckpoint } from "./schemas.ts";
import { GitError, runGit } from "./git.ts";

export type PinnedCheckpoint = { root: string; ref: string; commit: string };

function promptRef(sessionId: string, key: string) {
  const id = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";

  return `refs/pi-session-snapshots/chats/${id}/prompts/${key}`;
}

async function resolveRef(root: string, ref: string) {
  try { return (await runGit(root, ["rev-parse", "--verify", ref])).trim(); }
  catch (cause) {
    if (cause instanceof GitError && cause.exitCode === 128) return undefined;
    throw cause;
  }
}

async function pinCheckpoint(roots: Set<string>, sessionId: string, checkpoint: PromptCheckpoint, sourceOwner?: string): Promise<PinnedCheckpoint | undefined> {
  const ref = promptRef(sessionId, checkpoint.key);
  const source = promptRef(sourceOwner ?? checkpoint.owner, checkpoint.key);

  for (const root of roots) {
    if (await resolveRef(root, ref) === checkpoint.commit) return;

    if (await resolveRef(root, source) !== checkpoint.commit) continue;
    await runGit(root, ["update-ref", "--stdin"], {}, ["start", `verify ${source} ${checkpoint.commit}`, `create ${ref} ${checkpoint.commit}`, "prepare", "commit", ""].join("\n"));

    return { root, ref, commit: checkpoint.commit };
  }
}

export async function removePinnedCheckpoints(checkpoints: PinnedCheckpoint[]) {
  const results = await Promise.allSettled(checkpoints.map(checkpoint => runGit(checkpoint.root, ["update-ref", "-d", checkpoint.ref, checkpoint.commit])));
  const errors = results.flatMap((result, index) => result.status === "rejected" ? [new Error(`Could not remove created checkpoint ${JSON.stringify(checkpoints[index])}: ${String(result.reason)}`)] : []);

  if (errors.length) throw new AggregateError(errors, "Some created checkpoints could not be removed; recovery references were retained");
}

export async function pinPromptHistory(root: string | undefined, sessionId: string, entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, sourceOwner?: string) {
  const checkpoints = entries.flatMap(entry => entry.type === "custom" && entry.customType === "pi-project-prompt-checkpoint" && Check(checkpointSchema, entry.data) ? [entry.data] : []);
  const pinned: PinnedCheckpoint[] = [];

  try {
    for (const checkpoint of checkpoints) {
      const roots = new Set([root, checkpoint.repositoryRoot].flatMap(value => value ? [value] : []));
      const created = await pinCheckpoint(roots, sessionId, checkpoint, sourceOwner);

      if (created) pinned.push(created);
    }

    return pinned;
  } catch (cause) { await removePinnedCheckpoints(pinned); throw cause; }
}
