import { retainSettingsResources } from "./lib/settingsResources";
import { capSessionName } from "./lib/sessionName";
import { ComposerPluginsContext } from "./plugins/composer";
import { localHostLabel } from "./lib/mobileHosts";
import { hostChoices } from "./lib/hostChoices";
import { TranscriptPluginsContext, conversationSource } from "./plugins/transcript";
import { createPluginWorkspace } from "./plugins/workspace";
import { required } from "./lib/required";
import { trackToastMessage, trackToastNotices } from "./lib/toastHistory";
import { Key,Rerun } from "@solid-primitives/keyed";
import { Archive,ArrowLeft,Bug,FolderPlus,MessageSquare,Server,Settings } from "lucide-solid";
import { batch,createComponent,createEffect,createMemo,lazy,onCleanup,Show } from "solid-js";
import { createAppConversations } from "./appConversations";
import { AppLoading,LimitBadge,splitConversationKey } from "./appSupport";
import { FindInPage } from "./components/FindInPage";
import { IconButton } from "./components/IconButton";
import { DebugModeButton } from "./components/DebugModeButton";
import { debugView } from "./lib/debugFeatures";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { DraftRecovery } from "./components/DraftRecovery";
import { SessionPanel } from "./components/SessionPanel";
import { ArchivedSessionPanel } from "./components/ArchivedSessionPanel";
import { MissingDirectoryDialog } from "./components/MissingDirectoryDialog";
import { hasVisibleText } from "./lib/content";
import { NativeTransport } from "./lib/nativeTransport";
import { isMobile } from "./lib/platform";
import { SessionLinkContext, SubagentNavigationContext, type SessionLinks } from "./lib/subagentNavigation";
import type { SessionSummary } from "./types";

export { formatCodexReset,normalizeCodexUsage,normalizeOpencodeGoUsage,usageWindowsDescription } from "./appSupport";

const LocalSettingsView = lazy(() => import("./components/LocalSettingsView").then(module => ({ default: module.LocalSettingsView })));

const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));

function preloadSettings() {
  let disposed = false;
  const timer = setTimeout(() => {
    void import("./components/LocalSettingsView").catch(reason => console.error("Could not preload the settings page:", reason));
    void import("./lib/settingsResources").then(module => { if (!disposed) module.preloadSettingsResources(); }, reason => console.error("Could not preload the settings data:", reason));
  }, 1000);
  onCleanup(() => { disposed = true; clearTimeout(timer); });
}

const ChatView = lazy(() => import("./components/ChatView").then(module => ({ default: (props: Parameters<typeof module.ChatView>[0]) => {
  preloadSettings();
  return createComponent(module.ChatView, props);
} })));

const ExtensionDialog = lazy(() => import("./components/ExtensionDialog").then(module => ({ default: module.ExtensionDialog })));

const ProjectDialog = lazy(() => import("./components/ProjectDialog").then(module => ({ default: module.ProjectDialog })));

const SplitChatPane = lazy(() => import("./components/SplitChatPane").then(module => ({ default: module.SplitChatPane })));

const SubagentPane = lazy(() => import("./components/SubagentPane").then(module => ({ default: module.SubagentPane })));

export default function App(props: { suppressConnectionNotices?: boolean } = {}) {
  onCleanup(retainSettingsResources());
 const { modelVisibility, drafts, archiveReplacedSession, isArchiving, missingDirectoryDialog, archivesOpen, setArchivesOpen, runtimePool, transport, view, setView, activeConversationKey, chatViewKey, runningSessions, unseenSessions, pendingSettingsCount, chatSession, sessions, settings, settingsSaving, debugModeSaving, setSettingsDirty, panelOpen, setPanelOpen, query, setQuery, connected, error, setError, createGroupRequest, setCreateGroupRequest, handleCreateGroup, newChatRequest, activeHostId, codexUsage, usageClock, opencodeGoBadge, codexUsageError, opencodeGoUsageError, setDialogs, notices, setNotices, addNotice, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, releaseSplitTransport, statuses, renameSession, setRenameSession, projectOpen, setProjectOpen, projectOpenRef, uploadsByTransport, setComposerUploads, splitPane, setSplitPane, subagentPane, hasSidePane, mainComposerFocusRequest, splitComposerFocusRequest, activePane, setActivePane, terminals, terminalOpen, terminalLocationState, startTerminal, addTerminal, selectTerminal, deleteTerminal, reconnectPending, splitSessionId, composerState, terminalViewKey, syncSessionIndex, composerControls, resolveHomeDirectory, send, respondToSplitRequest, closeSplitPane, openSubagent, canLeaveSettings, rekeyConversationUi, branch, forkAndForget, forkSourceName, openForkSource, revealEntryId, entryRevealed, startNewSession, newSession, clearChatProject, chooseChatHost, selectSession, setModel, setThinking, abortInteraction, pauseInteraction, resumeInteraction, saveSettings, setAgent, openProject, chooseChatProject, sessionAction, draftChangeFor, uploadsChangeFor, toggleComposerTerminal, toggleDebugMode, toggleDebugFeature, reconnectMain, extensionStateIsCurrent, activeDialog, projectCwd, mobileSidebarOpen, sidebar, chatAgentProps, chatModels, chatCommands, chatWidgets, composerView } = createAppConversations(() => { void ChatView.preload().catch(() => undefined); });


  const pluginPane = createPluginWorkspace(conversationSource(activeHostId, chatSession), () => view() === "chat", closeSplitPane);
  createEffect(() => { if (hasSidePane()) pluginPane.close(); });

  const renderMobileSidebarBackdrop = () => (panelOpen() && view() === "chat" && <button class="mobile-sidebar-backdrop" aria-label="Close conversations" onClick={() => setPanelOpen(false)} />);

  const renderMobileSidebarToggle = () => <button type="button" class="mobile-sidebar-toggle" aria-label="Toggle conversations" aria-expanded={mobileSidebarOpen()} onClick={() => { if (canLeaveSettings()) { const open = !mobileSidebarOpen(); setView("chat"); setPanelOpen(open); } }}>☰</button>;

  const renderArchiveButton = () => {
    const active = () => archivesOpen() && view() === "chat";

    return <IconButton label={active() ? "Show regular sessions" : "Show archived sessions"} class={active() ? "active" : ""} aria-pressed={active()} onClick={() => {
      if (!canLeaveSettings()) return;
      setArchivesOpen(!active()); setView("chat"); setPanelOpen(true);
    }}><Archive size={18} /></IconButton>;
  };

  const renderSidebar = () => {
    const renderNavigation = () => (<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="Group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setArchivesOpen(false); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><DebugModeButton debugMode={required(settings()).debugMode} featuresOff={required(settings()).debugFeaturesOff ?? []} disabled={debugModeSaving() || settingsSaving()} onToggle={toggleDebugMode} onToggleFeature={toggleDebugFeature}><Bug size={18} /></DebugModeButton>{renderArchiveButton()}<IconButton label={view() === "settings" ? "Go back" : "Settings"} class={view() === "settings" ? "active" : ""} onClick={() => { if (view() !== "settings") { setView("settings");

        return; }

      if (canLeaveSettings()) setView("chat"); }}>{view() === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton>{isMobile && <IconButton label="Host" onClick={() => { window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}{panelOpen() && view() === "chat" && renderMobileSidebarToggle()}</nav>);

    const renderSessionPanel = () => (view() === "chat" && panelOpen() && <Show when={archivesOpen()} fallback={<SessionPanel transport={transport()} settings={required(settings())} isArchiving={isArchiving} debug={debugView(required(settings())).sessionActions} sidebar={sidebar} activeId={activeConversationKey().slice(activeHostId().length + 1)} activeHostId={activeHostId()} runningSessions={runningSessions()} unseenSessions={unseenSessions()} query={query()} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => void startNewSession(false, group)} createGroupRequest={createGroupRequest()} onCreateGroupHandled={handleCreateGroup} newChatRequest={newChatRequest()} />}><ArchivedSessionPanel /></Show>);
    const renderUsageBadges = () => (<div class="rail-bottom"><Show when={codexUsageError()}>{message => <span class="codex-usage" role="alert" title={message()} aria-label={message()}>Codex usage unavailable</span>}</Show><Show when={opencodeGoUsageError()}>{message => <span class="codex-usage opencode-go-usage" role="alert" title={message()} aria-label={message()}>Go usage unavailable</span>}</Show>{opencodeGoBadge() && <LimitBadge clock={usageClock()} label="OpenCode Go" prefix="Go " go detail={required((opencodeGoBadge())).detail} remainingPercent={required((opencodeGoBadge())).window.remainingPercent} resetAt={required((opencodeGoBadge())).window.resetAt} />}{codexUsage() !== undefined && <LimitBadge clock={usageClock()} label="Codex" remainingPercent={required((codexUsage())).remainingPercent} resetAt={required((codexUsage())).resetAt} />}</div>);

    return (<ResizableSidebar compact={view() === "settings" || !panelOpen()}>{renderNavigation()}{renderSessionPanel()}{renderUsageBadges()}</ResizableSidebar>);
  };

  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<Rerun on={chatViewKey}>{(_key) => <ChatView onNotice={(title, message) => addNotice({ title, message })} transcriptActions={pluginPane.button()} agentHostLabel={activeHostId() === "local" ? localHostLabel() : required(settings()).hosts.find(host => host.id === activeHostId())?.name ?? activeHostId()} transport={transport()}  state={composerView.state()} messages={chatSession().messages} debug={debugView(required(settings()))} {...composerView.agentProps()} refreshError={chatSession().error} capabilityErrors={chatSession().capabilityErrors} capabilitiesLoading={chatSession().capabilitiesLoading} onRetryCapabilities={chatSession().retryCapabilities} modelAliases={modelVisibility.aliases(activeHostId())} models={composerView.models()} commands={chatCommands()} thinkingLevels={composerView.thinkingLevels()} widgets={chatWidgets()} statuses={composerView.statuses()} projectCwd={projectCwd()} controlsDisabled={!connected()} draft={composerState().composerDraft} onDraftChange={draftChangeFor(activeConversationKey(), transport())} focusRequest={mainComposerFocusRequest()} onActivate={() => setActivePane("main")} uploads={composerState().composerUploads} onUploadsChange={uploadsChangeFor(transport())} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abortInteraction} onPause={pauseInteraction} onResume={resumeInteraction} onOpenTerminal={() => toggleComposerTerminal("main", { sessionKey: activeConversationKey(), cwd: projectCwd(), hostId: activeHostId() })} hosts={hostChoices(required(settings()))} onChooseHost={hostId => void chooseChatHost(hostId)} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onBranch={branch} onFork={message => branch(message, "fork")} onForkAndForget={forkAndForget} forkSourceName={forkSourceName()} onOpenForkSource={openForkSource} revealEntryId={revealEntryId()} onEntryRevealed={entryRevealed} onAgent={setAgent} onModel={setModel} onToggleFastMode={() => transport().promptControls.toggle(composerControls.statuses(statuses(), composerControls.state(chatSession().state).model))} onThinking={setThinking} />}</Rerun>);

      const renderSplitChatPane = () => (<Show when={splitPane()}><Rerun on={() => splitPane()?.key}>{(_key) => {
        const pane = required(splitPane());
        const currentPane = () => splitPane()?.key === pane.key ? splitPane() : undefined;

        const changeSession = (next: SessionSummary, owner: NativeTransport) => {
          const current = currentPane();

          if (!current) return;
          const previousKey = splitConversationKey(current);
          const nextKey = `${next.hostId ?? "local"}:${next.id}`;
          batch(() => {
            rekeyConversationUi(previousKey, nextKey, owner);
            setSplitPane(value => value?.key === pane.key ? { ...value, session: next } : value);
          });
        };

        return <SplitChatPane drafts={drafts} runtimePool={runtimePool()} uploadsFor={(owner) => uploadsByTransport().get(owner) ?? []} onUploadsChange={setComposerUploads}
          session={currentPane()?.session ?? pane.session} settings={required(settings())} modelVisibility={modelVisibility} draft={composerState().splitComposerDraft}
          focusRequest={splitComposerFocusRequest()} onActivate={() => { if (currentPane()) setActivePane("split"); }}
          onOpenTerminal={() => { const current = currentPane();

            if (current) toggleComposerTerminal("split", { sessionKey: splitConversationKey(current), cwd: current.session.cwd, hostId: current.session.hostId ?? "local" }); }}
          onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs}
          onOpenForkSource={source => openForkSource(source, (currentPane()?.session ?? pane.session).hostId ?? "local")}
          forkSourceName={source => sessions().find(session => session.id === source.sessionId && (session.hostId ?? "local") === ((currentPane()?.session ?? pane.session).hostId ?? "local"))?.name}
          onReleaseTransport={releaseSplitTransport} onArchiveOriginal={archiveReplacedSession} onSessionChange={changeSession} pluginPane={Boolean(pane.request)} readOnly={pane.request?.readOnly} actions={pane.request?.actions} notice={pane.request?.notice} onShowArchive={() => { setArchivesOpen(true); setPanelOpen(true); }} initialPrompt={pane.request?.initialPrompt} initialImages={pane.request?.initialImages}
          onReady={pane.request ? () => respondToSplitRequest(required(pane.request).requestId, { value: "opened" }) : undefined}
          onFailed={pane.request ? () => respondToSplitRequest(required(pane.request).requestId, { cancelled: true }) : undefined}
          onClose={() => { if (currentPane()) closeSplitPane(); }} />;
      }}</Rerun></Show>);

      return (<div class={`chat-panes ${hasSidePane() || pluginPane.open() ? "split" : ""}`}>
        <div class="main-chat" style={{ display: "contents" }} inert={sessions().some(session => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId() && isArchiving(session))}>
          {renderChatView()}
        </div>
        {renderSplitChatPane()}
        <Show when={subagentPane()} keyed>{(target) => <SubagentPane target={target} debug={debugView(required(settings()))} onClose={closeSplitPane} onActivate={() => setActivePane("split")} onShowArchive={() => { setArchivesOpen(true); setPanelOpen(true); }} />}</Show>
        {pluginPane.panel()}
      </div>);
    };

    return (<div class="chat-workspace" hidden={view() !== "chat"}>
      <DraftRecovery drafts={drafts} conversationKey={activeConversationKey()} onSelect={selectSession} />
      {renderChatPanes()}
      {terminals.prepareTerminal() && terminals.ready() && <div class="terminal-panel-container" classList={{ "terminal-panel-container-preparing": !terminalOpen() }} inert={!terminalOpen()} aria-hidden={!terminalOpen()}><Rerun on={terminalViewKey}>{(_key) => <TerminalView visible={terminalOpen() && view() === "chat"} ownershipRequired={!terminals.owned()} onTakeOwnership={terminals.takeOwnership} cwd={terminalLocationState().terminalCwd} terminals={terminals.state.sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={terminals.state.activeTerminal.id} output={terminals.state.activeTerminal.output} outputEnd={terminals.state.activeTerminal.outputEnd} snapshot={terminals.state.activeTerminal.snapshot} snapshotEnd={terminals.state.activeTerminal.snapshotEnd} started={terminals.state.activeTerminal.started} exited={terminals.state.activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} inputDraft={terminals.state.activeTerminal.inputDraft} onDraft={terminals.updateDraft} onData={terminals.write} onResize={terminals.resize} onSnapshot={((sessionId: string, terminalId: string, generation?: string) => (value: string, outputEnd: number) => terminals.saveTerminalSnapshot(sessionId, terminalId, value, outputEnd, generation))(terminals.terminalSessionId(), terminals.state.activeTerminal.id, terminals.state.activeTerminal.generation)} onDelete={deleteTerminal} onClose={terminals.close} />}</Rerun></div>}
    </div>);
  };

  const renderSettingsView = () => (view() === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount()} settings={required((settings()))} sessions={sessions()} onSave={saveSettings} onDirtyChange={setSettingsDirty} />);

  const connectionError = () => props.suppressConnectionNotices ? undefined : error();
  trackToastNotices("Chat", notices);
  trackToastMessage("Chat", "piop could not connect", connectionError);

  const renderToastStack = () => (<Show when={connectionError() || notices().length > 0}><div class="toast-stack">
    {connectionError() && <div class="error-toast" role="alert"><strong>piop could not connect</strong><span>{(connectionError())}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport())}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
    {<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}
  </div></Show>);

  const renderExtensionDialog = () => (activeDialog() && !missingDirectoryDialog() && !projectOpen() && !renameSession() && <Rerun on={() => activeDialog()?.queueId}>{(_key) => <ExtensionDialog request={required(activeDialog()).request} owner={required(activeDialog()).owner} onRespond={async (response) => {
    const capturedActiveDialog = required(activeDialog());
    await capturedActiveDialog.transport.command({ type: "extension_ui_response", id: capturedActiveDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== capturedActiveDialog)); }} />}</Rerun>);

  const renderProjectDialog = () => (projectOpen() && <ProjectDialog initialPath={projectCwd() ?? ""} hostId={activeHostId()} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport().listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />);
  const renderSubagentFind = () => subagentPane() && <FindInPage selector=".subagent-pane .chat-shell" scopeKey={`${required(subagentPane()).hostId}:${required(subagentPane()).sessionId}`} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />;

  const renderMissingDirectoryDialog = () => missingDirectoryDialog() && <Rerun on={() => missingDirectoryDialog()}>{() => <MissingDirectoryDialog request={required(missingDirectoryDialog())} />}</Rerun>;
  const workspaceLabel = () => connected() && !error() ? "Conversation workspace ready" : "Conversation workspace connecting";
  const renderSplitFind = () => splitPane() && <Rerun on={() => splitSessionId()}>{(_key) => <FindInPage selector=".split-chat .chat-shell" scopeKey={splitSessionId()} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />}</Rerun>;

  const listedSession = (hostId: string, sessionId: string) => sessions().find(session => session.id === sessionId && (session.hostId ?? "local") === hostId);
  const sessionLinks: SessionLinks = {
    name: (hostId, sessionId) => listedSession(hostId, sessionId)?.name,
    open: (hostId, sessionId) => { const session = listedSession(hostId, sessionId); if (session) selectSession(session); else addNotice({ title: "Could not open the session", message: "It is archived or deleted." }); },
  };

  return <SessionLinkContext.Provider value={sessionLinks}><SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div role="region" aria-label={workspaceLabel()} class={`app ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    {!mobileSidebarOpen() && renderMobileSidebarToggle()}
    {renderMobileSidebarBackdrop()}
    {renderSidebar()}
    <ComposerPluginsContext.Provider value={pluginPane.composers}><TranscriptPluginsContext.Provider value={pluginPane.transcripts}>{renderChatWorkspace()}</TranscriptPluginsContext.Provider></ComposerPluginsContext.Provider>
    {renderSettingsView()}
    <FindInPage selector=".chat-panes > .main-chat > .chat-shell" scopeKey={activeConversationKey()} onActivate={() => setActivePane("main")} active={activePane() === "main" || !hasSidePane()} enabled={view() === "chat"} />
    {renderSubagentFind()}
    {renderSplitFind()}
    {view() === "settings" && <FindInPage selector=".settings-shell" scopeKey="settings" />}
    {renderToastStack()}
    <BranchActivity />
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession() && <Rerun on={() => renameSession()?.session.id}>{(_key) => <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: required((renameSession())).session.name }} onRespond={async (response) => {
      const capturedRenameSession = renameSession(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId();

      if (response.cancelled) { setRenameSession(undefined);

        return; }

      if (response.value === undefined || !hasVisibleText(response.value)) throw new Error("Conversation name can't be empty"); const name = capSessionName(response.value); await required((capturedRenameSession)).transport.connect(); await required((capturedRenameSession)).transport.command({ type: "set_session_name", name });

      if (required((capturedRenameSession)).session.id === capturedSession.state.sessionId && (required((capturedRenameSession)).session.hostId ?? "local") === capturedActiveHostId) capturedSession.setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); }} />}</Rerun>}
    {renderMissingDirectoryDialog()}
  </div>)}</SubagentNavigationContext.Provider></SessionLinkContext.Provider>;
}

import { BranchActivity } from "./components/BranchActivity";
