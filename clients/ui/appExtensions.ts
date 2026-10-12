import type { Accessor } from "solid-js";
import { createComputed,createSignal } from "solid-js";
import { dialogOwnerName,type OwnedExtensionDialog } from "./appSupport";
import { NativeTransport } from "./lib/nativeTransport";
import { createRef } from "./lib/solid";
import { useChatSession } from "./lib/useChatSession";
import type { DefinedAgentsCapability,ExtensionUiRequest } from "./types";

export function createAppExtensions({ transport, chatSession }: { transport: Accessor<NativeTransport>; chatSession: Accessor<ReturnType<typeof useChatSession>> }) {

  const [definedAgents, setDefinedAgents] = createSignal<DefinedAgentsCapability>();
  const [dialogs, setDialogs] = createSignal<OwnedExtensionDialog[]>([]);
  const dialogsRef = createRef(dialogs()); createComputed(() => { dialogsRef.current = dialogs(); });
  const mainDialogOwnerRef = createRef("Main conversation"); createComputed(() => { mainDialogOwnerRef.current = dialogOwnerName(chatSession().state.sessionName); });
  const queueExtensionDialog = (request: ExtensionUiRequest, ownerTransport: NativeTransport, owner: string) => setDialogs((current) => current.some((dialog) => dialog.transport === ownerTransport && dialog.request.id === request.id) ? current : [...current, { request, transport: ownerTransport, owner, queueId: crypto.randomUUID() }]);
  const resolveExtensionDialog = (owner: NativeTransport, id: string) => setDialogs((current) => current.filter((dialog) => dialog.transport !== owner || dialog.request.id !== id));

  const closeTransportDialogs = async (ownerTransport: NativeTransport) => {
    setDialogs((current) => current.filter((dialog) => dialog.transport !== ownerTransport));
  };

  /** Tells Pi that the user will not answer this transport's open dialogs, then removes them. */
  const cancelTransportDialogs = async (ownerTransport: NativeTransport) => {
    const owned = dialogsRef.current.filter((dialog) => dialog.transport === ownerTransport);
    setDialogs((current) => current.filter((dialog) => dialog.transport !== ownerTransport));
    const results = await Promise.allSettled(owned.map((dialog) => ownerTransport.command({ type: "extension_ui_response", id: dialog.request.id, cancelled: true })));
    const failure = results.find((result) => result.status === "rejected");

    if (failure) throw failure.reason;
  };

  const [statuses, setStatuses] = createSignal<Record<string, string>>({});
  const [widgets, setWidgets] = createSignal<Record<string, string[]>>({});
  const [extensionOwner, setExtensionOwner] = createSignal(transport());

 return { definedAgents, setDefinedAgents, dialogs, setDialogs, dialogsRef, mainDialogOwnerRef, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, cancelTransportDialogs, statuses, setStatuses, widgets, setWidgets, extensionOwner, setExtensionOwner };
}
