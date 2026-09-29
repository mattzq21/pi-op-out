import { createMemo, createSignal, type Accessor } from "solid-js";
import { BTW_REQUEST_TITLE, MCP_STATUS_KEY, PROMPT_CONTEXT_STATUS_KEY, dialogOwnerName, staleExtensionContext, type OwnedExtensionDialog, type SplitPaneState } from "./appSupport";
import { decodeAgentValue, DEFINED_AGENTS_STATUS_KEY } from "./lib/agentProtocol";
import type { NativeTransport } from "./lib/nativeTransport";
import { createRef } from "./lib/solid";
import type { useChatSession } from "./lib/useChatSession";
import type { DefinedAgentsCapability, ExtensionUiRequest, ImageAttachment, RpcEvent } from "./types";

type ExtensionContext = {
  transport: Accessor<NativeTransport>;
  isCurrent: (owner: NativeTransport) => boolean;
  session: Accessor<ReturnType<typeof useChatSession>>;
  addNotice: (notice: { title: string; message: string }) => void;
  openBtw: (pane: SplitPaneState) => void;
  setEditorText: (owner: NativeTransport, text?: string) => void;
};

export function createAppExtensions({ transport, isCurrent, session, addNotice, openBtw, setEditorText }: ExtensionContext) {
  const [dialogs, setDialogs] = createSignal<OwnedExtensionDialog[]>([]);
  const [definedAgents, setDefinedAgents] = createSignal<DefinedAgentsCapability>();
  const [statuses, setStatuses] = createSignal<Record<string, string>>({});
  const [widgets, setWidgets] = createSignal<Record<string, string[]>>({});
  const [extensionOwner, setExtensionOwner] = createSignal(transport());
  const pendingBtwRequest = createRef<{ id: string; transport: NativeTransport } | undefined>(undefined);
  const btwImages = new WeakMap<NativeTransport, ImageAttachment[]>();
  const queueExtensionDialog = (request: ExtensionUiRequest, ownerTransport: NativeTransport, owner: string) => setDialogs((current) => current.some((dialog) => dialog.transport === ownerTransport && dialog.request.id === request.id) ? current : [...current, { request, transport: ownerTransport, owner, queueId: crypto.randomUUID() }]);
  const resolveExtensionDialog = (owner: NativeTransport, id: string) => setDialogs((current) => current.filter((dialog) => dialog.transport !== owner || dialog.request.id !== id));
  const closeTransportDialogs = async (ownerTransport: NativeTransport) => {
    setDialogs((current) => current.filter((dialog) => dialog.transport !== ownerTransport));
  };
  const respondToBtw = (requestId: string, response: { value?: string; cancelled?: boolean }) => {
    const pending = pendingBtwRequest.current; if (!pending || pending.id !== requestId) return;
    pendingBtwRequest.current = undefined;
    void pending.transport.command({ type: "extension_ui_response", id: requestId, ...response }).catch((reason) => addNotice({ title: "Could not finish /btw request", message: reason instanceof Error ? reason.message : String(reason) }));
  };
  const handleRequest = (owner: NativeTransport, event: RpcEvent) => {
    const request = event as unknown as ExtensionUiRequest;
    if (!isCurrent(owner)) return;
    const notifyExtension = () => { if (!event.inputRejected) addNotice({ title: request.notifyType === "error" ? "Extension error" : request.notifyType === "warning" ? "Extension warning" : "piop extension", message: request.message || "Notification" }); };
    const btwPayload = () => {
      const payload = JSON.parse(request.placeholder || "{}") as { task?: unknown; sessionFile?: unknown; cwd?: unknown };
      if (typeof payload.task !== "string" || !payload.task.trim() || typeof payload.sessionFile !== "string" || !payload.sessionFile) throw new Error("Invalid /btw branch request");
      return { task: payload.task, sessionFile: payload.sessionFile, cwd: payload.cwd };
    };
    const handleBtw = () => {
      try {
        const payload = btwPayload();
        const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ".";
        const previous = pendingBtwRequest.current;
        if (previous && previous.id !== request.id) void previous.transport.command({ type: "extension_ui_response", id: previous.id, cancelled: true }).catch(() => undefined);
        pendingBtwRequest.current = { id: request.id, transport: owner };
        openBtw({
          key: crypto.randomUUID(),
          session: { id: `btw-${request.id}`, path: "", name: "BTW", project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, preview: payload.task, messageCount: 0, lastMessageAt: Date.now(), apiCost: 0, hostId: owner.currentHostId() },
          btw: { task: payload.task, forkFrom: payload.sessionFile, requestId: request.id, images: btwImages.get(owner) },
        });
        btwImages.delete(owner);
      } catch (reason) {
        void owner.command({ type: "extension_ui_response", id: request.id, cancelled: true });
        addNotice({ title: "Could not start /btw", message: reason instanceof Error ? reason.message : String(reason) });
      }
    };
    const setDefinedAgentStatus = () => {
      setExtensionOwner(owner);
      try {
        const capability = request.statusText?.startsWith("json:") ? decodeAgentValue<DefinedAgentsCapability>(request.statusText.slice(5)) : undefined;
        setDefinedAgents(capability);
        if (capability) void session().refresh().catch(() => undefined);
      } catch { setDefinedAgents(undefined); }
    };
    const setExtensionStatus = () => {
      setExtensionOwner(owner);
      setStatuses((current) => { const next = { ...current }; if (request.statusText) next[request.statusKey!] = request.statusText; else delete next[request.statusKey!]; return next; });
    };
    const setExtensionWidget = () => {
      setExtensionOwner(owner);
      setWidgets((current) => { const next = { ...current }; if (request.widgetLines) next[request.widgetKey!] = (Array.isArray(request.widgetLines) ? request.widgetLines : []).filter((line): line is string => typeof line === "string").map((line) => line.slice(0, 500)).slice(0, 50); else delete next[request.widgetKey!]; return next; });
    };
    const setExtensionTitle = () => { document.title = request.title || "piop"; };
    const updateEditor = () => {
      setEditorText(owner, request.text);
    };
    const handleStatus = () => { if (request.statusKey === DEFINED_AGENTS_STATUS_KEY) return setDefinedAgentStatus(); if (request.statusKey === MCP_STATUS_KEY) return; if (request.statusKey && request.statusKey !== PROMPT_CONTEXT_STATUS_KEY) return setExtensionStatus(); };
    const openExtensionDialog = () => { queueExtensionDialog(request, owner, dialogOwnerName(session().state.sessionName)); };
    if (request.method === "notify") return notifyExtension();
    if (request.method === "input" && request.title === BTW_REQUEST_TITLE) return handleBtw();
    if (request.method === "setStatus") return handleStatus();
    if (request.method === "setWidget" && request.widgetKey) return setExtensionWidget();
    const otherMethods: Record<string, () => void> = { setTitle: setExtensionTitle, set_editor_text: updateEditor, input: openExtensionDialog, editor: openExtensionDialog, select: openExtensionDialog, confirm: openExtensionDialog };
    if (Object.hasOwn(otherMethods, request.method)) return otherMethods[request.method]();
  };

  const handleEvent = (owner: NativeTransport, event: RpcEvent) => {
    if (event.type === "extension_ui_request") handleRequest(owner, event);
    if (event.type === "extension_ui_resolved") resolveExtensionDialog(owner, String(event.id));
    if (event.type === "extension_error") {
      const message = String(event.error ?? "An extension failed");
      if (!message.startsWith(staleExtensionContext)) addNotice({ title: "Extension error", message });
    }
  };
  const activate = () => { document.title = "piop"; setStatuses({}); setWidgets({}); };
  const clearAgents = () => setDefinedAgents(undefined);
  const disconnect = (owner: NativeTransport) => { clearAgents(); activate(); void closeTransportDialogs(owner); };
  const retainBtwImages = (owner: NativeTransport, images: ImageAttachment[]) => btwImages.set(owner, images);
  const dismissDialog = (dialog: OwnedExtensionDialog) => setDialogs(current => current.filter(item => item !== dialog));
  const respondToDialog = async (dialog: OwnedExtensionDialog, response: { value?: string; cancelled?: boolean }) => {
    await dialog.transport.command({ type: "extension_ui_response", id: dialog.request.id, ...response });
    dismissDialog(dialog);
  };
  const stateIsCurrent = createMemo(() => extensionOwner() === transport());
  const agentProps = () => {
    if (!stateIsCurrent()) return { agents: [], activeAgent: undefined, agentLocked: false, agentSaved: false, agentUnavailable: false };
    return { agents: definedAgents()?.config.agents ?? [], activeAgent: definedAgents()?.active, agentLocked: definedAgents()?.locked, agentSaved: definedAgents()?.saved, agentUnavailable: definedAgents()?.unavailable };
  };
  const visibleWidgets = createMemo(() => stateIsCurrent() ? Object.values(widgets()).flat() : []);
  const visibleStatuses = createMemo(() => stateIsCurrent() ? statuses() : {});
  return { dialogs, definedAgents, clearAgents, agentProps, visibleWidgets, visibleStatuses, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, respondToBtw, retainBtwImages, dismissDialog, respondToDialog, handleEvent, activate, disconnect };
}
export type AppExtensions = ReturnType<typeof createAppExtensions>;
