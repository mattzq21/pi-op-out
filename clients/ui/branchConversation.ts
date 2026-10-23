import { z } from "zod";
import { agentStateSchema, entrySchema, forkAfterResultSchema } from "./lib/responseSchemas";
import { branchCwd } from "./lib/branching";
import { beginBranching } from "./lib/branchActivity";
import { type Dispatch, type RefObject, type StateUpdate } from "./lib/solid";

import { branchMessages, type PiEntry } from "./lib/messages";
import { NativeTransport } from "./lib/nativeTransport";
import { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { resolveMessageEntry } from "./lib/resolveMessageEntry";
import type { AgentState, AppSettings, ChatMessage, SessionSummary } from "./types";

type Context = {
  transport: NativeTransport;
  activeConversationKeyRef: RefObject<string>;
  branchPending: RefObject<Set<string>>;
  state: AgentState;
  sessions: SessionSummary[];
  runtimePool: SessionRuntimePool;
  messages: ChatMessage[];
  rekeyConversationUi: (previousKey: string, nextKey: string, ownerTransport: NativeTransport, mode?: "rename" | "branch") => void;
  activeTransportRef: RefObject<NativeTransport>;
  setActiveCwd: Dispatch<StateUpdate<string | undefined>>;
  setState: Dispatch<StateUpdate<AgentState>>;
  setMessages: Dispatch<StateUpdate<ChatMessage[]>>;
  updateConnected: (value: boolean) => void;
  configureRuntime: (value: AppSettings) => Promise<void>;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  activateConversationKey: (key: string) => void;
  addNotice: (notice: { title: string; message: string; }) => void;
  syncSessionIndex: () => Promise<void>;
  requestComposerFocus: () => void;
};

export function createBranchConversation({ transport, activeConversationKeyRef, branchPending, state, sessions, runtimePool, rekeyConversationUi, activeTransportRef, setActiveCwd, setState, setMessages, updateConnected, configureRuntime, transportConversationKeys, activateConversationKey, syncSessionIndex, requestComposerFocus }: Context) {
  /** "branch" creates a worktree; "fork" keeps the folder; "copy" also transfers the draft for Fork and forget. */
  return async (message: ChatMessage, mode: "branch" | "fork" | "copy" = "branch") => {
    const ownerTransport = transport; const previousKey = activeConversationKeyRef.current;
    const entryId = await resolveMessageEntry(ownerTransport, message);
    const pendingKey = `${previousKey}:${entryId}`;

    if (branchPending.current.has(pendingKey)) return false;
    const sourcePath = ownerTransport.currentSessionPath() ?? state.sessionFile;

    if (!sourcePath) throw new Error("The original conversation has no session file");
    branchPending.current.add(pendingKey);
    const sourceCwd = ownerTransport.currentCwd();
    const sourceHostId = ownerTransport.currentHostId();
    const parentSession = [...sessions, ...runtimePool.liveSessionSummaries()].find((session) => session.path === sourcePath && (session.hostId ?? "local") === sourceHostId);

    const forkSource = async () => {
      const fork = await ownerTransport.command({ type: mode === "branch" ? "fork_after" : "copy_after", entryId }, forkAfterResultSchema);

      if (fork.cancelled) return false;

      return { cwd: fork.state?.cwd ?? undefined };

    };

    const publishBranch = (nextState: AgentState, history: { entries: PiEntry[]; leafId: string | null }, nextKey: string, cwd: string | undefined) => {
      if (cwd !== undefined) ownerTransport.adoptBranchCwd(cwd);

      if (parentSession) {
        runtimePool.setLiveSession(ownerTransport, { ...parentSession, id: nextState.sessionId, forkSourceId: parentSession.id, path: nextState.sessionFile ?? "", cwd: cwd ?? parentSession.cwd, name: nextState.sessionName || parentSession.name, messageCount: nextState.messageCount });
      }

      rekeyConversationUi(previousKey, nextKey, ownerTransport, mode === "copy" ? "rename" : "branch");

      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === nextKey) {
        if (cwd !== undefined) setActiveCwd(cwd);
        setState(nextState); setMessages(branchMessages(history.entries, history.leafId)); updateConnected(true); requestComposerFocus();
      }

    };

    const restoreBranchSource = async () => {
      if (activeTransportRef.current === ownerTransport) updateConnected(false);
      await ownerTransport.disconnect();
      await ownerTransport.connect(sourceCwd, sourcePath, sourceHostId);

      if (activeTransportRef.current === ownerTransport) setActiveCwd(sourceCwd);
      const restoredSettings = await ownerTransport.loadSettings();
      await configureRuntime(restoredSettings);
      const restoredState = await ownerTransport.command({ type: "get_state" }, agentStateSchema);
      const restoredHistory = await ownerTransport.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]) }));
      transportConversationKeys.current.set(ownerTransport, previousKey);

      if (activeTransportRef.current === ownerTransport) { activateConversationKey(previousKey); setState(restoredState); setMessages(branchMessages(restoredHistory.entries, restoredHistory.leafId)); updateConnected(true); }
    };

    const rollbackBranch = async (cause: unknown) => {
      try {
        await restoreBranchSource();
      } catch (rollbackReason) {
        const originalMessage = cause instanceof Error ? cause.message : String(cause);
        const rollbackMessage = rollbackReason instanceof Error ? rollbackReason.message : String(rollbackReason);
        throw new Error(`${originalMessage}\nCould not restore the original conversation: ${rollbackMessage}`);
      }

    };

    let forked = false;
    const finishBranching = beginBranching();

    try {
      const forked_ = await forkSource();

      if (!forked_) return false;
      forked = true;
      const nextState = await ownerTransport.command({ type: "get_state" }, agentStateSchema);
      const history = await ownerTransport.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]) }));

      const nextKey = `${sourceHostId}:${nextState.sessionId}`;
      runtimePool.bind(sourceHostId, nextState.sessionId, ownerTransport);
      publishBranch(nextState, history, nextKey, mode === "branch" ? branchCwd(forked_.cwd, nextState.cwd) : sourceCwd);

      void syncSessionIndex();

      return true;
    } catch (reason) {
      if (!forked) throw reason;
      await rollbackBranch(reason);
      throw reason;
    } finally { branchPending.current.delete(pendingKey); finishBranching(); }
  };
}
