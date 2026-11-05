import { Key, Rerun } from "@solid-primitives/keyed";
import { createMemo, lazy, Show, untrack } from "solid-js";
import type { AppConversations } from "./appConversations";
import { MissingDirectoryDialog } from "./components/MissingDirectoryDialog";
import { renameConversation } from "./lib/conversationLookup";
import { required } from "./lib/required";
import { createToastMessageTracker, createToastNoticeTracker } from "./lib/toastHistory";
import type { ExtensionUiResponse } from "./types";

const ExtensionDialog = lazy(() => import("./components/ExtensionDialog").then(module => ({ default: module.ExtensionDialog })));

const ProjectDialog = lazy(() => import("./components/ProjectDialog").then(module => ({ default: module.ProjectDialog })));

// The notices at the bottom of the page, and the connection error.
export function AppNotices(props: { notices: AppConversations["notices"]; transport: AppConversations["conversation"]["transport"]; suppressConnectionNotices?: boolean }) {
  const { notices, setNotices, error, setError, reconnectMain, reconnectPending } = untrack(() => props.notices);
  const transport = untrack(() => props.transport);
  const connectionError = createMemo(() => props.suppressConnectionNotices ? undefined : error());
  createToastNoticeTracker("Chat", notices);
  createToastMessageTracker("Chat", "piop could not connect", connectionError);

  const renderToastStack = () => (<Show when={connectionError() || notices().length > 0}><div class="toast-stack">
    {connectionError() && <div class="error-toast" role="alert"><strong>piop could not connect</strong><span>{(connectionError())}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport())}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
    {<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}
  </div></Show>);

  return renderToastStack();
}

// The dialogs of extensions, projects, renames and missing folders.
export function AppDialogs(props: { dialogs: AppConversations["dialogs"]; conversation: Pick<AppConversations["conversation"], "transport" | "chatSession" | "activeHostId" | "projectCwd" | "openProject" | "resolveHomeDirectory">; syncSessionIndex: AppConversations["sessions"]["syncSessionIndex"] }) {
  const { setDialogs, activeDialog, renameSession, setRenameSession, projectOpen, setProjectOpen, projectOpenRef, missingDirectoryDialog } = untrack(() => props.dialogs);
  const { transport, chatSession, activeHostId, projectCwd, openProject, resolveHomeDirectory } = untrack(() => props.conversation);
  const syncSessionIndex = untrack(() => props.syncSessionIndex);

  const respondExtension = async (dialog: NonNullable<ReturnType<typeof activeDialog>>, response: ExtensionUiResponse) => {
    await dialog.transport.command({ type: "extension_ui_response", id: dialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== dialog)); };

  const respondRename = async (renaming: NonNullable<ReturnType<typeof renameSession>>, session: ReturnType<typeof chatSession>, hostId: string, response: ExtensionUiResponse) => {
    if (response.cancelled) { setRenameSession(undefined);

      return; }

    const target = renaming.session; const name = await renameConversation(target.id, target.hostId ?? "local", response.value ?? "");

    if (target.id === session.state.sessionId && (target.hostId ?? "local") === hostId) session.setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); };

  const renderExtensionDialog = () => (activeDialog() && !missingDirectoryDialog() && !projectOpen() && !renameSession() && <Rerun on={() => activeDialog()?.queueId}>{(_key) => <ExtensionDialog request={required(activeDialog()).request} owner={required(activeDialog()).owner} onRespond={(response) => respondExtension(required(activeDialog()), response)} />}</Rerun>);

  const renderProjectDialog = () => (projectOpen() && <ProjectDialog initialPath={projectCwd() ?? ""} hostId={activeHostId()} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport().listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />);
  const renderMissingDirectoryDialog = () => missingDirectoryDialog() && <Rerun on={() => missingDirectoryDialog()}>{() => <MissingDirectoryDialog request={required(missingDirectoryDialog())} />}</Rerun>;


  return <>
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession() && <Rerun on={() => renameSession()?.session.id}>{(_key) => <ExtensionDialog selectPrefill request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: required((renameSession())).session.name }} onRespond={(response) => respondRename(required(renameSession()), { ...chatSession() }, activeHostId(), response)} />}</Rerun>}
    {renderMissingDirectoryDialog()}
  </>;
}
