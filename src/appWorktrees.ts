import type { Accessor, Setter } from "solid-js";
import type { WorktreeTarget } from "./appSupport";
import { textOf } from "./lib/content";
import { branchMessages, type PiEntry } from "./lib/messages";
import type { NativeTransport } from "./lib/nativeTransport";
import { updateSessionGroups } from "./lib/sessionGroups";
import type { SessionRuntimePool } from "./lib/sessionRuntimePool";
import type { StateUpdate } from "./lib/solid";
import type { AppSettings, ComposerUpload, SessionSummary } from "./types";

type WorktreeContext = {
  settings: Accessor<AppSettings | undefined>;
  runtimePool: Accessor<SessionRuntimePool>;
  transport: Accessor<NativeTransport>;
  addNotice: (notice: { title: string; message: string }) => unknown;
  setWorktreeTarget: Setter<WorktreeTarget | undefined>;
  setSessions: Setter<SessionSummary[]>;
  setComposerDraft: (key: string, update: StateUpdate<string>) => unknown;
  setComposerUploads: (owner: NativeTransport, update: StateUpdate<ComposerUpload[]>) => unknown;
  selectSession: (session: SessionSummary) => unknown;
  syncSessionIndex: () => unknown;
};

export function createWorktreeActions(context: WorktreeContext) {
  const { settings, runtimePool, transport, addNotice, setWorktreeTarget, setSessions, setComposerDraft, setComposerUploads, selectSession, syncSessionIndex } = context;
  const createWorktree = async (target: WorktreeTarget, name: string, onSetup?: (cancel: (() => Promise<void>) | undefined) => void) => { const capturedSettings = settings(); const capturedRuntimePool = runtimePool();
    const addWorktreeGroup = async (result: { path: string; branch: string; sessionId?: string }) => {
      try {
        await updateSessionGroups({
          type: "project", project: {
            id: `${target.hostId}:${result.path}`, name: result.branch, cwd: result.path,
            hostId: target.hostId, hostName: capturedSettings?.hosts.find((host) => host.id === target.hostId)?.name ?? (target.hostId === "local" ? "Local" : target.hostId),
            projectKind: "worktree",
          }, key: result.sessionId ? `${target.hostId}:${result.sessionId}` : undefined
        });
      } catch (reason) {
        addNotice({ title: "Worktree created, but could not add its group", message: `${result.path}\n${String(reason)}` });
      }
    };
    const setup = async (path: string) => {
      try { await target.transport.runWorktreeSetup(target.cwd, path, target.hostId, onSetup); return true; }
      catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        addNotice({ title: message === "Environment setup cancelled" ? "Environment setup cancelled; worktree kept" : "Worktree created, but environment setup failed", message: `${path}\n${message}` });
        return false;
      }
    };
    if (!target.message) {
      const result = await target.transport.createProjectWorktree(target.cwd, name, target.hostId);
      await addWorktreeGroup(result);
      await setup(result.path);
      setWorktreeTarget(undefined);
      return result;
    }
    const sourceMessage = target.message;
    const owner = target.transport;
    const beforePrompt = sourceMessage.role === "user";
    const history = await owner.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" });
    const message = branchMessages(history.entries, history.leafId).find((message) => message.role === sourceMessage.role && (sourceMessage.entryId ? message.entryId === sourceMessage.entryId : message.timestamp === sourceMessage.timestamp && textOf(message.content) === textOf(sourceMessage.content)));
    if (!message?.entryId) throw new Error("Could not find the message in the saved conversation");
    const result = await owner.command<{ branch: string; path: string; sessionPath: string; sessionId: string }>({ type: "branch_checkpoint", entryId: message.entryId, name, afterResponse: !beforePrompt });
    await addWorktreeGroup(result);
    await setup(result.path);
    setWorktreeTarget(undefined);
    const session: SessionSummary = { id: result.sessionId, path: result.sessionPath, cwd: result.path, cwdExists: true, projectKind: "worktree", project: result.branch, name: result.branch, preview: "", messageCount: 0, lastMessageAt: 0, apiCost: 0, hostId: target.hostId };
    setSessions((current) => [...current, session]);
    setComposerDraft(`${target.hostId}:${result.sessionId}`, beforePrompt ? textOf(sourceMessage.content) : "");
    const branchTransport = capturedRuntimePool.forSession(session);
    setComposerUploads(branchTransport, beforePrompt && Array.isArray(sourceMessage.content) ? sourceMessage.content.flatMap((part) => part.type === "image" && part.data && part.mimeType ? [{ id: crypto.randomUUID(), name: "Attached image", kind: "image" as const, byteSize: Math.ceil(part.data.length * 3 / 4), image: { type: "image" as const, data: part.data, mimeType: part.mimeType } }] : []) : []);
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
