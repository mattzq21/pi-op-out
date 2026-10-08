import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { GitError, runGit } from "./git.ts";

const snapshotSchema = Type.Object({
  ref: Type.String({ pattern: "^refs/pi-session-snapshots/" }),
  commit: Type.String({ pattern: "^[a-fA-F0-9]{40,64}$" }),
});

type History = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

async function resolveRef(root: string, ref: string) {
  try { return (await runGit(root, ["rev-parse", "--verify", ref])).trim(); }
  catch (error) {
    if (error instanceof GitError && error.exitCode === 128) return undefined;
    throw error;
  }
}

async function recordedSnapshot(root: string, history: History, archive: boolean) {
  for (const entry of [...history].reverse()) {
    if (entry.type !== "custom" || entry.customType !== "pi-project-files-watch-snapshot") continue;

    if (!Check(snapshotSchema, entry.data) || entry.data.ref.includes("/archive/") !== archive) continue;

    if (await resolveRef(root, entry.data.ref) === entry.data.commit) return { ref: entry.data.ref, commit: entry.data.commit };
  }
}

async function legacyCompletedSnapshot(root: string, prefix: string) {
  const output = await runGit(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%09%(objectname)", prefix]);

  for (const line of output.split("\n")) {
    const [ref, commit] = line.split("\t");

    if (commit && ref.startsWith(prefix) && /^\d{8}T\d{9}Z-[a-f0-9]{12}-[a-f0-9]{8}$/.test(ref.slice(prefix.length))) return { ref, commit };
  }
}

export async function currentSnapshot(root: string, sessionId: string, history?: History) {
  if (history) {
    const completed = await recordedSnapshot(root, history, false);

    if (completed) return completed;
    const archived = await recordedSnapshot(root, history, true);

    if (archived) return archived;
  }

  const id = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+|\.+$/g, "") || "session";

  if (!history?.some(entry => entry.type === "custom" && entry.customType === "pi-project-files-watch-snapshot")) {
    const completed = await legacyCompletedSnapshot(root, `refs/pi-session-snapshots/chats/${id}/`);

    if (completed) return completed;
  }

  const ref = `refs/pi-session-snapshots/${id}`;
  const commit = await resolveRef(root, ref);

  return commit ? { ref, commit } : undefined;
}
