import { Key, Rerun } from "@solid-primitives/keyed";
import { lazy, Show } from "solid-js";
import type { AppConversations } from "./appConversations";
import { MissingDirectoryDialog } from "./components/MissingDirectoryDialog";
import { renameConversation } from "./lib/conversationLookup";
import { required } from "./lib/required";
import { trackToastMessage, trackToastNotices } from "./lib/toastHistory";

const ExtensionDialog = lazy(() => import("./components/ExtensionDialog").then(module => ({ default: module.ExtensionDialog })));

const ProjectDialog = lazy(() => import("./components/ProjectDialog").then(module => ({ default: module.ProjectDialog })));

// The notices at the bottom of the page, and the connection error.
export function AppNotices(props: { notices: AppConversations["notices"]; transport: AppConversations["conversation"]["transport"]; suppressConnectionNotices?: boolean }) {
  const { notices, setNotices, error, setError, reconnectMain, reconnectPending } = props.notices;
  const transport = props.transport;
  const connectionError = () => props.suppressConnectionNotices ? undefined : error();
  trackToastNotices("Chat", notices);
  trackToastMessage("Chat", "piop could not connect", connectionError);

  const renderToastStack = () => (<Show when={connectionError() || notices().length > 0}><div class="toast-stack">
    {connectionError() && <div class="error-toast" role="alert"><strong>piop could not connect</strong><span>{(connectionError())}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport())}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
    {<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}
  </div></Show>);

  return renderToastStack();
}

// The dialogs of extensions, projects, renames and missing folders.
export function AppDialogs(props: { dialogs: AppConversations["dialogs"]; conversation: Pick<AppConversations["conversation"], "transport" | "chatSession" | "activeHostId" | "projectCwd" | "openProject" | "resolveHomeDirectory">; syncSessionIndex: AppConversations["sessions"]["syncSessionIndex"] }) {
  const { setDialogs, activeDialog, renameSession, setRenameSession, projectOpen, setProjectOpen, projectOpenRef, missingDirectoryDialog } = props.dialogs;
  const { transport, chatSession, activeHostId, projectCwd, openProject, resolveHomeDirectory } = props.conversation;
  const syncSessionIndex = props.syncSessionIndex;

  const renderExtensionDialog = () => (activeDialog() && !missingDirectoryDialog() && !projectOpen() && !renameSession() && <Rerun on={() => activeDialog()?.queueId}>{(_key) => <ExtensionDialog request={required(activeDialog()).request} owner={required(activeDialog()).owner} onRespond={async (response) => {
    const capturedActiveDialog = required(activeDialog());
    await capturedActiveDialog.transport.command({ type: "extension_ui_response", id: capturedActiveDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== capturedActiveDialog)); }} />}</Rerun>);

  const renderProjectDialog = () => (projectOpen() && <ProjectDialog initialPath={projectCwd() ?? ""} hostId={activeHostId()} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport().listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />);
  const renderMissingDirectoryDialog = () => missingDirectoryDialog() && <Rerun on={() => missingDirectoryDialog()}>{() => <MissingDirectoryDialog request={required(missingDirectoryDialog())} />}</Rerun>;


  return <>
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession() && <Rerun on={() => renameSession()?.session.id}>{(_key) => <ExtensionDialog selectPrefill request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: required((renameSession())).session.name }} onRespond={async (response) => {
      const capturedRenameSession = renameSession(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId();

      if (response.cancelled) { setRenameSession(undefined);

        return; }

      const target = required(capturedRenameSession).session; const name = await renameConversation(target.id, target.hostId ?? "local", response.value ?? "");

      if (required((capturedRenameSession)).session.id === capturedSession.state.sessionId && (required((capturedRenameSession)).session.hostId ?? "local") === capturedActiveHostId) capturedSession.setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); }} />}</Rerun>}
    {renderMissingDirectoryDialog()}
  </>;
}
