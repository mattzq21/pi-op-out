import { z } from "zod";
import { agentStateSchema, entrySchema } from "./lib/responseSchemas";
import type { TerminalTarget } from "./appSupport";
import { beginBranching } from "./lib/branchActivity";
import { type Dispatch, type RefObject, type StateUpdate } from "./lib/solid";

import { branchMessages, type PiEntry } from "./lib/messages";
import { NativeTransport } from "./lib/nativeTransport";
import { SessionRuntimePool } from "./lib/sessionRuntimePool";
import { inheritSessionGroup } from "./lib/sessionGroups";
import type { AgentState, AppSettings, ChatMessage, SessionSummary } from "./types";

type Context = {
  transport: NativeTransport;
  activeConversationKeyRef: RefObject<string>;
  branchPending: RefObject<Set<string>>;
  state: AgentState;
  sessions: SessionSummary[];
  runtimePool: SessionRuntimePool;
  messages: ChatMessage[];
  rekeyConversationUi: (previousKey: string, nextKey: string, ownerTransport: NativeTransport, moveTerminals?: boolean, copyDraft?: boolean) => void;
  activeTransportRef: RefObject<NativeTransport>;
  setActiveCwd: Dispatch<StateUpdate<string | undefined>>;
  setTerminalOpen: Dispatch<StateUpdate<boolean>>;
  setTerminalTarget: Dispatch<StateUpdate<TerminalTarget | undefined>>;
  setState: Dispatch<StateUpdate<AgentState>>;
  setMessages: Dispatch<StateUpdate<ChatMessage[]>>;
  updateConnected: (value: boolean) => void;
  configureRuntime: (value: AppSettings) => Promise<void>;
  transportConversationKeys: RefObject<Map<NativeTransport, string>>;
  activateConversationKey: (key: string) => void;
  addNotice: (notice: { title: string; message: string; }) => void;
  syncSessionIndex: () => Promise<void>;
};

export function createBranchConversation({ transport, activeConversationKeyRef, branchPending, state, sessions, runtimePool, rekeyConversationUi, activeTransportRef, setActiveCwd, setTerminalOpen, setTerminalTarget, setState, setMessages, updateConnected, configureRuntime, transportConversationKeys, activateConversationKey, addNotice, syncSessionIndex }: Context) {
  return async (message: ChatMessage, destinationCwd?: string) => {
    const entryId = message.entryId;

    if (!entryId) throw new Error("Could not find the response to branch from");
    const ownerTransport = transport; const previousKey = activeConversationKeyRef.current;
    const pendingKey = `${previousKey}:${entryId}`;

    if (branchPending.current.has(pendingKey)) return false;
    const sourcePath = ownerTransport.currentSessionPath() ?? state.sessionFile;

    if (!sourcePath) throw new Error("The original conversation has no session file");
    branchPending.current.add(pendingKey);
    const sourceCwd = ownerTransport.currentCwd();
    const sourceHostId = ownerTransport.currentHostId();
    const parentSession = [...sessions, ...runtimePool.liveSessionSummaries()].find((session) => session.path === sourcePath && (session.hostId ?? "local") === sourceHostId);

    const forkSource = async () => {
      const fork = await ownerTransport.command({ type: "fork_after", entryId }, z.object({ cancelled: z.boolean().optional() }));

      if (fork.cancelled) return false;

      return true;

    };

    const publishBranch = (nextState: AgentState, history: { entries: PiEntry[]; leafId: string | null }, nextKey: string) => {
      if (!destinationCwd && parentSession) {
        runtimePool.setLiveSession(ownerTransport, { ...parentSession, id: nextState.sessionId, path: nextState.sessionFile ?? "", name: nextState.sessionName || parentSession.name, messageCount: nextState.messageCount });
      }

      rekeyConversationUi(previousKey, nextKey, ownerTransport, !destinationCwd);

      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === nextKey) {
        if (destinationCwd) { setActiveCwd(destinationCwd); setTerminalOpen(false); setTerminalTarget(undefined); }

        setState(nextState); setMessages(branchMessages(history.entries, history.leafId)); updateConnected(true);
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

    const relocateBranch = async (nextState: AgentState, destinationCwd: string) => {
      if (!nextState.sessionFile) throw new Error("The branched conversation has no session file");
      await ownerTransport.relocateSession(nextState.sessionFile, destinationCwd, sourceHostId);

      if (activeTransportRef.current === ownerTransport && activeConversationKeyRef.current === previousKey) updateConnected(false);
      await ownerTransport.disconnect(); await ownerTransport.connect(destinationCwd, nextState.sessionFile, sourceHostId);
      const nextSettings = await ownerTransport.loadSettings(); await configureRuntime(nextSettings); nextState = await ownerTransport.command({ type: "get_state" }, agentStateSchema); const history = await ownerTransport.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]) }));

      return { nextState, history };
    };

    let sourceDiffs: import("./types").GitDiffSnapshots | undefined;

    const copyBranchDiffs = async (nextState: AgentState, history: { entries: PiEntry[]; leafId: string | null }) => {
      if (sourceDiffs === undefined) return;

      try { await runtimePool.copySavedDiffs(ownerTransport, sourcePath, nextState.sessionFile, new Set(branchMessages(history.entries, history.leafId).map((entry) => entry.id)), sourceDiffs); }
      catch (reason) { addNotice({ title: "Conversation branched, but project changes could not be copied", message: reason instanceof Error ? reason.message : String(reason) }); }

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
      sourceDiffs = await runtimePool.captureMemoryDiffs(ownerTransport);

      if (!await forkSource()) return false;
      forked = true;
      let nextState = await ownerTransport.command({ type: "get_state" }, agentStateSchema);
      let history = await ownerTransport.command({ type: "get_entries" }, z.object({ entries: z.array(entrySchema), leafId: z.union([z.string(), z.null()]) }));
      await copyBranchDiffs(nextState, history);

      if (destinationCwd) {
        ({ nextState, history } = await relocateBranch(nextState, destinationCwd));
      }

      const nextKey = `${sourceHostId}:${nextState.sessionId}`;
      await inheritSessionGroup(`${sourceHostId}:${state.sessionId}`, nextKey, parentSession);
      runtimePool.bind(sourceHostId, nextState.sessionId, ownerTransport);
      publishBranch(nextState, history, nextKey);

      if (destinationCwd) void syncSessionIndex();

      return true;
    } catch (reason) {
      if (!forked) throw reason;
      await rollbackBranch(reason);
      throw reason;
    } finally { branchPending.current.delete(pendingKey); finishBranching(); }
  };
}
