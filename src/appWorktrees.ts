import { z } from "zod";
import { entrySchema } from "./lib/responseSchemas";
import type { Accessor, Setter } from "solid-js";
import type { WorktreeTarget } from "./appSupport";
import { textOf } from "./lib/content";
import { branchMessages } from "./lib/messages";
import type { NativeTransport } from "./lib/nativeTransport";
import type { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { inheritSessionGroup, updateSessionGroups } from "./lib/sessionGroups";
import type { StateUpdate } from "./lib/solid";
import type { AppSettings, ComposerUpload, SessionSummary } from "./types";

type WorktreeContext = {
  settings: Accessor<AppSettings | undefined>;
  runtimePool: Accessor<SessionRuntimePool>;
  transport: Accessor<NativeTransport>;
  addNotice: (notice: { title: string; message: string }) => void;
  setWorktreeTarget: Setter<WorktreeTarget | undefined>;
  setSessions: Setter<SessionSummary[]>;
  setComposerDraft: (key: string, update: StateUpdate<string>) => void;
  setComposerUploads: (owner: NativeTransport, update: StateUpdate<ComposerUpload[]>) => void;
  selectSession: (session: SessionSummary) => void;
  syncSessionIndex: () => Promise<void>;
};

async function sourceSession(target: WorktreeTarget) {
  const sourcePath = target.transport.currentSessionPath();
  const parent = (await target.transport.listSessions()).find((session) => session.path === sourcePath && (session.hostId ?? "local") === target.hostId);
  const parentId = parent?.id ?? (await target.transport.command({ type: "get_state" }, z.object({ sessionId: z.string() }))).sessionId;
  const projectRoot = parent?.projectRoot ?? parent?.cwd ?? target.cwd;

  return { parent, parentId, projectRoot };
}

function projectName(root: string) { return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root; }

export function createWorktreeActions(context: WorktreeContext) {
  const { runtimePool, transport, addNotice, setWorktreeTarget, setSessions, setComposerDraft, setComposerUploads, selectSession, syncSessionIndex } = context;

  const createWorktree = async (target: WorktreeTarget, name: string, onSetup?: (cancel: (() => Promise<void>) | undefined) => void) => { const capturedRuntimePool = runtimePool();

    const setup = async (path: string) => {
      try { await target.transport.runWorktreeSetup(target.cwd, path, target.hostId, onSetup);

      return true; }
      catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        addNotice({ title: message === "Environment setup cancelled" ? "Environment setup cancelled; worktree kept" : "Worktree created, but environment setup failed", message: `${path}\n${message}` });

        return false;
      }
    };

    if (!target.message) {
      const result = await target.transport.createProjectWorktree(target.cwd, name, target.hostId);
      try {
        await updateSessionGroups({ type: "project", project: {
          id: `${target.hostId}:${result.path}`, name: result.branch, cwd: result.path,
          hostId: target.hostId, projectKind: "worktree", branch: result.branch,
        } });
      } catch (reason) {
        addNotice({ title: "Worktree created, but could not be added to the sidebar", message: `${result.path}\n${reason instanceof Error ? reason.message : String(reason)}` });
      }
      await setup(result.path);
      setWorktreeTarget(undefined);

      void syncSessionIndex();

      return result;
    }

    const sourceMessage = target.message;
    const owner = target.transport;
    const beforePrompt = sourceMessage.role === "user";
    const history = await owner.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]) }));
    const messages = branchMessages(history.entries, history.leafId);
    const message = messages.find((message) => message.role === sourceMessage.role && (sourceMessage.entryId ? message.entryId === sourceMessage.entryId : message.timestamp === sourceMessage.timestamp && textOf(message.content) === textOf(sourceMessage.content)));

    if (!message?.entryId) throw new Error("Could not find the message in the saved conversation");
    const sourcePath = owner.currentSessionPath();
    const { parent, parentId, projectRoot } = await sourceSession(target);
    const sourceDiffs = await capturedRuntimePool.captureMemoryDiffs(owner);
    const result = await owner.command({ type: "branch_checkpoint", entryId: message.entryId, name, afterResponse: !beforePrompt }, z.object({ branch: z.string(), path: z.string(), sessionPath: z.string(), sessionId: z.string() }));
    await inheritSessionGroup(`${target.hostId}:${parentId}`, `${target.hostId}:${result.sessionId}`, parent);
    await setup(result.path);
    setWorktreeTarget(undefined);
    const session: SessionSummary = { id: result.sessionId, path: result.sessionPath, cwd: result.path, cwdExists: true, projectKind: "worktree", projectRoot, worktreeRoot: result.path, branch: result.branch, project: projectName(projectRoot), name: result.branch, preview: "", messageCount: 0, lastMessageAt: 0, apiCost: 0, hostId: target.hostId };
    setSessions((current) => [...current, session]);
    setComposerDraft(`${target.hostId}:${result.sessionId}`, beforePrompt ? textOf(sourceMessage.content) : "");
    const branchTransport = capturedRuntimePool.forSession(session);
    const cutoff = messages.findIndex(entry => entry.entryId === message.entryId);

    try { await capturedRuntimePool.copySavedDiffs(branchTransport, sourcePath, result.sessionPath, new Set(messages.slice(0, cutoff + (beforePrompt ? 0 : 1)).map(entry => entry.id)), sourceDiffs); }
    catch (reason) { addNotice({ title: "Worktree created, but project changes could not be copied", message: String(reason) }); }

    setComposerUploads(branchTransport, beforePrompt && Array.isArray(sourceMessage.content) ? sourceMessage.content.flatMap((part): ComposerUpload[] => part.type === "image" && part.data && part.mimeType ? [{ id: crypto.randomUUID(), name: "Attached image", kind: "image", byteSize: Math.ceil(part.data.length * 3 / 4), image: { type: "image", data: part.data, mimeType: part.mimeType } }] : []) : []);
    selectSession(session);
    void syncSessionIndex();

    return result;
  };

  const deleteWorktree = async (cwd: string, hostId: string, deleteBranch: boolean) => { const capturedTransport = transport();
    const result = await capturedTransport.removeGitWorktree(cwd, hostId, deleteBranch);

    if (result.warning) addNotice({ title: "Worktree deleted with a warning", message: result.warning });
    void syncSessionIndex();
  };

  return { createWorktree, deleteWorktree };
}
