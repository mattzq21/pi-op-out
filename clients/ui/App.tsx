import { preloadSettingsResources, retainSettingsResources } from "./lib/settingsResources";
import { renameConversation } from "./lib/conversationLookup";
import { ComposerPluginsContext } from "./plugins/composer";
import { localHostLabel } from "./lib/mobileHosts";
import { hostChoices } from "./lib/hostChoices";
import { TranscriptPluginsContext, conversationSource } from "./plugins/transcript";
import { createPluginWorkspace } from "./plugins/workspace";
import { Sidepane } from "./plugins/Sidepane";
import { SidepaneTabs } from "./components/SidepaneTabs";
import type { SidepaneTab } from "./lib/sidepaneTabs";
import { AuxiliaryChatsContext, type AuxiliaryChats } from "./lib/auxiliaryChats";
import { required } from "./lib/required";
import { trackToastMessage, trackToastNotices } from "./lib/toastHistory";
import { Key,Rerun } from "@solid-primitives/keyed";
import { Archive,ArrowLeft,Bug,FolderPlus,MessageSquare,PanelRight,Server,Settings } from "lucide-solid";
import { createComponent,lazy,onCleanup,Show } from "solid-js";
import { createAppConversations } from "./appConversations";
import { AppLoading,LimitBadge,selectedProjectCwd,splitConversationKey,UsageError } from "./appSupport";
import { createTranscriptCache } from "./components/transcriptCache";
import { useSessionMemory } from "./lib/sessionMemory";
import { FindInPage } from "./components/FindInPage";
import { IconButton } from "./components/IconButton";
import { DebugModeButton } from "./components/DebugModeButton";
import { debugView } from "./lib/debugFeatures";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { DraftRecovery } from "./components/DraftRecovery";
import { SessionPanel } from "./components/SessionPanel";
import { ArchivedSessionPanel } from "./components/ArchivedSessionPanel";
import { MissingDirectoryDialog } from "./components/MissingDirectoryDialog";
import { isMobile } from "./lib/platform";
import { SessionLinkContext, SubagentNavigationContext, type SessionLinks } from "./lib/subagentNavigation";

export { formatCodexReset,usageWindowsDescription } from "./appSupport";

const LocalSettingsView = lazy(() => import("./components/LocalSettingsView").then(module => ({ default: module.LocalSettingsView })));

const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));

function preloadSettings() {
  let disposed = false;
  // The page code only; its data needs a Pi session, so it loads when the user points at or focuses Settings.
  const timer = setTimeout(() => {
    if (!disposed) void import("./components/LocalSettingsView").catch(reason => console.error("Could not preload the settings page:", reason));
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
 const { forkSourceNameOf, modelVisibility, drafts, isArchiving, missingDirectoryDialog, archivesOpen, setArchivesOpen, runtimePool, transport, view, setView, activeConversationKey, chatViewKey, runningSessions, unseenSessions, pendingSettingsCount, chatSession, sessions, settings, settingsSaving, debugModeSaving, setSettingsDirty, panelOpen, setPanelOpen, query, setQuery, connected, error, setError, createGroupRequest, setCreateGroupRequest, handleCreateGroup, newChatRequest, activeHostId, codexUsage, anthropicUsage, usageClock, opencodeGoBadge, usageError, refreshUsage, refreshingUsage, setDialogs, notices, setNotices, addNotice, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, releaseSplitTransport, statuses, renameSession, setRenameSession, projectOpen, setProjectOpen, projectOpenRef, uploadsByTransport, setComposerUploads, splitPane, subagentPane, hasSidePane, sidepane, listedRunningSessions, archiveSession, mainComposerFocusRequest, splitComposerFocusRequest, activePane, setActivePane, terminals, terminalOpen, terminalLocationState, startTerminal, addTerminal, selectTerminal, deleteTerminal, reconnectPending, splitSessionId, composerState, terminalViewKey, syncSessionIndex, composerControls, resolveHomeDirectory, send, respondToSplitRequest, closeSplitPane, openSubagent, canLeaveSettings, branch, forkAndForget, forkSourceName, forkPoints, openForkSource, revealEntryId, entryRevealed, startNewSession, newSession, clearChatProject, chooseChatHost, selectSession, setModel, setThinking, abortInteraction, saveSettings, setAgent, openProject, chooseChatProject, sessionAction, draftChangeFor, uploadsChangeFor, toggleComposerTerminal, toggleDebugMode, toggleDebugFeature, reconnectMain, extensionStateIsCurrent, activeDialog, projectCwd, mobileSidebarOpen, sidebar, chatAgentProps, chatModels, chatCommands, chatWidgets, composerView } = createAppConversations(() => { void ChatView.preload().catch(() => undefined); }, owner => transcriptCache.prepare(owner));
  /** The drawn turns of recent chats. A chat that is not shown has the input that the main view would give it. */
  const transcriptCache = createTranscriptCache(owner => {
    const session = useSessionMemory(() => owner, () => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 }));
    const hostId = owner.currentHostId();

    return () => ({ messages: session.messages, state: session.state, debug: settings() ? debugView(required(settings())) : undefined, cwd: selectedProjectCwd(owner.currentCwd(), owner.isTemporaryChat()), notify: (title, message) => addNotice({ title, message }), forkSourceName: forkSourceNameOf(session.state.forkSource, hostId), actions: { onBranch: branch, onFork: message => branch(message, "fork"), onForkAndForget: forkAndForget, onOpenForkSource: openForkSource } });
  });


  const pluginPane = createPluginWorkspace(conversationSource(activeHostId, chatSession));

  /**
   * X on a tab: a btw or review chat is archived with its own auxiliary chats, such as its subagents, after a confirmation
   * while any of them works. A subagent tab only closes.
   */
  const closeTab = async (tab: SidepaneTab) => {
    if (tab.kind === "subagent") { sidepane.forget(tab.key); return; }

    if (sidepane.workingTree(tab.session) && !window.confirm(`“${tab.label}” or one of its subagents is working. Stop them and archive it?`)) return;
    await archiveSession(tab.session);
  };

  /** The side pane shows its tabs, or a plugin load error when there are no tabs. */
  const sideVisible = () => sidepane.open() && (sidepane.tabs().length > 0 || Boolean(pluginPane.error()));
  const sidepaneButton = () => <Show when={sidepane.tabs().length || pluginPane.error()}><IconButton class="open-plugins-button" label={sidepane.working() ? "Open side pane, a side chat is working" : "Open side pane"} aria-controls="plugin-sidepane" aria-expanded={sideVisible()} onClick={() => { if (sideVisible()) closeSplitPane(); else { sidepane.setOpen(true); setActivePane("split"); } }}><PanelRight size={19} /><Show when={sidepane.working()}><span class="sidepane-dot" /></Show></IconButton></Show>;

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
    const renderNavigation = () => (<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="Group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setArchivesOpen(false); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><DebugModeButton debugMode={required(settings()).debugMode} featuresOff={required(settings()).debugFeaturesOff ?? []} disabled={debugModeSaving() || settingsSaving()} onToggle={toggleDebugMode} onToggleFeature={toggleDebugFeature}><Bug size={18} /></DebugModeButton>{renderArchiveButton()}<IconButton label={view() === "settings" ? "Go back" : "Settings"} class={view() === "settings" ? "active" : ""} onPointerEnter={() => { if (view() !== "settings") preloadSettingsResources(); }} onFocus={() => { if (view() !== "settings") preloadSettingsResources(); }} onClick={() => { if (view() !== "settings") { setView("settings");

        return; }

      if (canLeaveSettings()) setView("chat"); }}>{view() === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton>{isMobile && <IconButton label="Host" onClick={() => { window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}</nav>);

    const renderSessionPanel = () => (view() === "chat" && panelOpen() && <Show when={archivesOpen()} fallback={<SessionPanel transport={transport()} settings={required(settings())} isArchiving={isArchiving} debug={debugView(required(settings())).sessionActions} sidebar={sidebar} activeId={activeConversationKey().slice(activeHostId().length + 1)} activeHostId={activeHostId()} runningSessions={listedRunningSessions()} unseenSessions={unseenSessions()} query={query()} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => void startNewSession(false, group)} createGroupRequest={createGroupRequest()} onCreateGroupHandled={handleCreateGroup} newChatRequest={newChatRequest()} />}><ArchivedSessionPanel /></Show>);
    const renderUsageBadges = () => (<div class="rail-bottom"><Show when={usageError()}>{message => <UsageError message={message()} />}</Show><Show when={opencodeGoBadge()}>{badge => <LimitBadge clock={usageClock()} refreshing={refreshingUsage("opencodeGo")} onRefresh={() => refreshUsage("opencodeGo")} label="OpenCode Go" provider="opencode" detail={badge().detail} remainingPercent={badge().window.remainingPercent} resetAt={badge().window.resetAt} stale={badge().error} />}</Show><Show when={anthropicUsage()}>{entry => <LimitBadge clock={usageClock()} refreshing={refreshingUsage("anthropic")} onRefresh={() => refreshUsage("anthropic")} label="Anthropic" provider="anthropic" remainingPercent={entry().usage.remainingPercent} resetAt={entry().usage.resetAt} stale={entry().error} />}</Show><Show when={codexUsage()}>{entry => <LimitBadge clock={usageClock()} refreshing={refreshingUsage("codex")} onRefresh={() => refreshUsage("codex")} label="Codex" provider="openai" remainingPercent={entry().usage.remainingPercent} resetAt={entry().usage.resetAt} stale={entry().error} />}</Show></div>);

    return (<ResizableSidebar compact={view() === "settings" || !panelOpen()}>{renderNavigation()}{renderSessionPanel()}<Show when={view() !== "settings"}>{renderUsageBadges()}</Show></ResizableSidebar>);
  };

  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<Rerun on={chatViewKey}>{(_key) => <ChatView transcripts={transcriptCache} onNotice={(title, message) => addNotice({ title, message })} transcriptActions={sidepaneButton()} agentHostLabel={activeHostId() === "local" ? localHostLabel() : required(settings()).hosts.find(host => host.id === activeHostId())?.name ?? activeHostId()} transport={transport()}  state={composerView.state()} messages={chatSession().messages} debug={debugView(required(settings()))} {...composerView.agentProps()} refreshError={chatSession().error} capabilityErrors={chatSession().capabilityErrors} capabilitiesLoading={chatSession().capabilitiesLoading} onRetryCapabilities={chatSession().retryCapabilities} modelAliases={modelVisibility.aliases(activeHostId())} models={composerView.models()} commands={chatCommands()} thinkingLevels={composerView.thinkingLevels()} widgets={chatWidgets()} statuses={composerView.statuses()} projectCwd={projectCwd()} controlsDisabled={!connected()} draft={composerState().composerDraft} onDraftChange={draftChangeFor(activeConversationKey(), transport())} focusRequest={mainComposerFocusRequest()} onActivate={() => setActivePane("main")} uploads={composerState().composerUploads} onUploadsChange={uploadsChangeFor(transport())} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abortInteraction} onOpenTerminal={() => toggleComposerTerminal("main", { sessionKey: activeConversationKey(), cwd: projectCwd(), hostId: activeHostId() })} hosts={hostChoices(required(settings()))} onChooseHost={hostId => void chooseChatHost(hostId)} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onBranch={branch} onFork={message => branch(message, "fork")} onForkAndForget={forkAndForget} forkSourceName={forkSourceName()} forkPoints={forkPoints()} onOpenForkSource={openForkSource} revealEntryId={revealEntryId()} onEntryRevealed={entryRevealed} onAgent={setAgent} onModel={setModel} onToggleFastMode={() => transport().promptControls.toggle(composerControls.statuses(statuses(), composerControls.state(chatSession().state).model))} onThinking={setThinking} />}</Rerun>);

      const renderSplitChatPane = () => (<Show when={splitPane()}><Rerun on={() => splitPane()?.key}>{(_key) => {
        const pane = required(splitPane());
        const currentPane = () => splitPane()?.key === pane.key ? splitPane() : undefined;

        const finishOpening = (response: { value?: string; cancelled?: boolean }) => {
          const opening = pane.request;

          if (!opening) return;
          sidepane.finishOpening(pane.key);
          respondToSplitRequest(opening.requestId, response);
        };

        return <SplitChatPane drafts={drafts} runtimePool={runtimePool()} uploadsFor={(owner) => uploadsByTransport().get(owner) ?? []} onUploadsChange={setComposerUploads}
          session={currentPane()?.session ?? pane.session} settings={required(settings())} modelVisibility={modelVisibility} draft={composerState().splitComposerDraft}
          focusRequest={splitComposerFocusRequest()} onActivate={() => { if (currentPane()) setActivePane("split"); }}
          onOpenTerminal={() => { const current = currentPane();

            if (current) toggleComposerTerminal("split", { sessionKey: splitConversationKey(current), cwd: current.session.cwd, hostId: current.session.hostId ?? "local" }); }}
          onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs}
          onReleaseTransport={releaseSplitTransport} initialPrompt={pane.request?.initialPrompt} initialImages={pane.request?.initialImages}
          onReady={() => finishOpening({ value: "opened" })} onFailed={() => finishOpening({ cancelled: true })}
          onClose={() => { if (currentPane()) sidepane.forget(pane.key); }} />;
      }}</Rerun></Show>);

      return (<div class={`chat-panes ${sideVisible() ? "split" : ""}`}>
        <div class="main-chat" style={{ display: "contents" }} inert={sessions().some(session => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId() && isArchiving(session))}>
          {renderChatView()}
        </div>
        <Sidepane open={sideVisible() && view() === "chat"}>
          <SidepaneTabs tabs={sidepane.tabs()} selected={sidepane.selected()?.key} error={pluginPane.error() || undefined} onSelect={key => { sidepane.select(key); setActivePane("split"); }} onClose={tab => void closeTab(tab)}>
            {renderSplitChatPane()}
            <Show when={subagentPane()} keyed>{(target) => <SubagentPane target={target} debug={debugView(required(settings()))} onActivate={() => setActivePane("split")} onShowArchive={() => { setArchivesOpen(true); setPanelOpen(true); }} />}</Show>
          </SidepaneTabs>
        </Sidepane>
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
  // A chat that a command just opened has a tab before the session list has it.
  const auxiliaryTab = (hostId: string, sessionId: string) => sidepane.tabs().find(tab => tab.key === `${hostId}:${sessionId}`);
  const auxiliaryChats: AuxiliaryChats = {
    listed: (hostId, sessionId) => Boolean(listedSession(hostId, sessionId)?.auxiliaryParentId || auxiliaryTab(hostId, sessionId)),
    open: (hostId, sessionId) => {
      const session = listedSession(hostId, sessionId) ?? auxiliaryTab(hostId, sessionId)?.session;
      if (session) { sidepane.openAuxiliary(session); setActivePane("split"); }
    },
  };
  const sessionLinks: SessionLinks = {
    name: (hostId, sessionId) => listedSession(hostId, sessionId)?.name,
    open: (hostId, sessionId) => { const session = listedSession(hostId, sessionId); if (session) selectSession(session); else addNotice({ title: "Could not open the session", message: "It is archived or deleted." }); },
  };

  return <SessionLinkContext.Provider value={sessionLinks}><AuxiliaryChatsContext.Provider value={auxiliaryChats}><SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div role="region" aria-label={workspaceLabel()} class={`app ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    {!mobileSidebarOpen() && renderMobileSidebarToggle()}
    {renderMobileSidebarBackdrop()}
    {renderSidebar()}
    <ComposerPluginsContext.Provider value={pluginPane.composers}><TranscriptPluginsContext.Provider value={pluginPane.transcripts}><transcriptCache.Host />{renderChatWorkspace()}</TranscriptPluginsContext.Provider></ComposerPluginsContext.Provider>
    {renderSettingsView()}
    <FindInPage selector=".chat-panes > .main-chat > .chat-shell" scopeKey={activeConversationKey()} onActivate={() => setActivePane("main")} active={activePane() === "main" || !hasSidePane()} enabled={view() === "chat"} />
    {renderSubagentFind()}
    {renderSplitFind()}
    {view() === "settings" && <FindInPage selector=".settings-shell" scopeKey="settings" />}
    {renderToastStack()}
    <BranchActivity />
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession() && <Rerun on={() => renameSession()?.session.id}>{(_key) => <ExtensionDialog selectPrefill request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: required((renameSession())).session.name }} onRespond={async (response) => {
      const capturedRenameSession = renameSession(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId();

      if (response.cancelled) { setRenameSession(undefined);

        return; }

      const target = required(capturedRenameSession).session; const name = await renameConversation(target.id, target.hostId ?? "local", response.value ?? "");

      if (required((capturedRenameSession)).session.id === capturedSession.state.sessionId && (required((capturedRenameSession)).session.hostId ?? "local") === capturedActiveHostId) capturedSession.setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); }} />}</Rerun>}
    {renderMissingDirectoryDialog()}
  </div>)}</SubagentNavigationContext.Provider></AuxiliaryChatsContext.Provider></SessionLinkContext.Provider>;
}

import { BranchActivity } from "./components/BranchActivity";
