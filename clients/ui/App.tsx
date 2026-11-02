import { preloadSettingsResources } from "./lib/settingsResources";
import { locateConversation, renameConversation } from "./lib/conversationLookup";
import { ArchivedLinkPopup, type ArchivedLink } from "./components/ArchivedLinkPopup";
import { createDependencyEffect } from "./lib/solid";
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
import { Archive,Bug,FolderPlus,MessageSquare,PanelRight,Server,Settings } from "lucide-solid";
import { createComponent,createMemo,createSignal,lazy,onCleanup,Show } from "solid-js";
import { AgentsPill } from "./components/AuxiliaryAgents";
import { sameFacts, subagentFacts } from "./lib/subagentFacts";
import { createAppConversations } from "./appConversations";
import { AppLoading,LimitBadge,OpencodexBadges,selectedProjectCwd,splitConversationKey,UsageError } from "./appSupport";
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
 const { forkSourceNameOf, modelVisibility, drafts, isArchiving, missingDirectoryDialog, archivesOpen, setArchivesOpen, runtimePool, transport, view, setView, activeConversationKey, chatViewKey, runningSessions, unseenSessions, pendingSettingsCount, chatSession, sessions, settings, settingsSaving, debugModeSaving, setSettingsDirty, panelOpen, setPanelOpen, query, setQuery, connected, error, setError, createGroupRequest, setCreateGroupRequest, handleCreateGroup, newChatRequest, activeHostId, codexUsage, anthropicUsage, usageClock, opencodeGoBadge, opencodexUsage, usageError, refreshUsage, refreshingUsage, setDialogs, notices, setNotices, addNotice, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, releaseSplitTransport, statuses, renameSession, setRenameSession, projectOpen, setProjectOpen, projectOpenRef, uploadsByTransport, setComposerUploads, splitPane, subagentPane, hasSidePane, sidepane, listedRunningSessions, archiveSession, mainComposerFocusRequest, splitComposerFocusRequest, mainQueueHoldRequest, splitQueueHoldRequest, activePane, setActivePane, terminals, terminalOpen, terminalLocationState, startTerminal, addTerminal, selectTerminal, deleteTerminal, reconnectPending, splitSessionId, composerState, terminalViewKey, syncSessionIndex, composerControls, resolveHomeDirectory, send, respondToSplitRequest, closeSplitPane, openSubagent, canLeaveSettings, branch, forkSourceName, forkPoints, openForkSource, revealEntryId, entryRevealed, startNewSession, newSession, clearChatProject, chooseChatHost, selectSession, setModel, setThinking, abortInteraction, saveSettings, setAgent, openProject, chooseChatProject, sessionAction, draftChangeFor, uploadsChangeFor, toggleComposerTerminal, toggleDebugMode, toggleDebugFeature, reconnectMain, extensionStateIsCurrent, activeDialog, projectCwd, mobileSidebarOpen, sidebar, chatAgentProps, chatModels, chatCommands, chatWidgets, composerView } = createAppConversations(() => { void ChatView.preload().catch(() => undefined); }, owner => transcriptCache.prepare(owner));
  const transcriptCache = createTranscriptCache(owner => {
    const session = useSessionMemory(() => owner, () => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 }));
    const hostId = owner.currentHostId();

    return () => ({ messages: session.messages, state: session.state, debug: settings() ? debugView(required(settings())) : undefined, cwd: selectedProjectCwd(owner.currentCwd(), owner.isTemporaryChat()), notify: (title, message) => addNotice({ title, message }), forkSourceName: forkSourceNameOf(session.state.forkSource, hostId), actions: { onBranch: branch, onFork: message => branch(message, "fork"), onOpenForkSource: openForkSource } });
  });


  const pluginPane = createPluginWorkspace(conversationSource(activeHostId, chatSession));

  const closeTab = async (tab: SidepaneTab) => {
    if (tab.kind === "subagent") { sidepane.forget(tab.key); return; }

    if (sidepane.workingTree(tab.session) && !window.confirm(`“${tab.label}” or one of its subagents is working. Stop them and archive it?`)) return;
    await archiveSession(tab.session);
  };

  const sideVisible = () => sidepane.open() && (sidepane.tabs().length > 0 || Boolean(pluginPane.error()));
  const sidepaneButton = () => <Show when={sidepane.tabs().length || pluginPane.error()}><IconButton class="open-plugins-button" label={sidepane.working() ? "Open side pane, a side chat is working" : "Open side pane"} aria-controls="plugin-sidepane" aria-expanded={sideVisible()} onClick={() => { if (sideVisible()) closeSplitPane(); else { sidepane.setOpen(true); setActivePane("split"); } }}><PanelRight size={19} /><Show when={sidepane.working()}><span class="sidepane-dot" /></Show></IconButton></Show>;

  const subagents = createMemo(() => subagentFacts(chatSession().messages, activeHostId()), undefined, { equals: sameFacts });
  const agentsIndicator = () => <AgentsPill agents={sidepane.agents()} subagents={subagents} onOpen={agent => { sidepane.openAuxiliary(agent.session); setActivePane("split"); }} />;

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
    const renderNavigation = () => (<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="Group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setArchivesOpen(false); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><DebugModeButton debugMode={required(settings()).debugMode} featuresOff={required(settings()).debugFeaturesOff ?? []} disabled={debugModeSaving() || settingsSaving()} onToggle={toggleDebugMode} onToggleFeature={toggleDebugFeature}><Bug size={18} /></DebugModeButton>{renderArchiveButton()}<IconButton label="Settings" onPointerEnter={() => preloadSettingsResources()} onFocus={() => preloadSettingsResources()} onClick={() => setView("settings")}><Settings size={19} /></IconButton>{isMobile && <IconButton label="Host" onClick={() => { window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}</nav>);

    const renderSessionPanel = () => (panelOpen() && <Show when={archivesOpen()} fallback={<SessionPanel transport={transport()} settings={required(settings())} isArchiving={isArchiving} debug={debugView(required(settings())).sessionActions} sidebar={sidebar} activeId={activeConversationKey().slice(activeHostId().length + 1)} activeHostId={activeHostId()} runningSessions={listedRunningSessions()} unseenSessions={unseenSessions()} query={query()} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => void startNewSession(false, group)} createGroupRequest={createGroupRequest()} onCreateGroupHandled={handleCreateGroup} newChatRequest={newChatRequest()} />}><ArchivedSessionPanel /></Show>);
    const renderUsageBadges = () => (<div class="rail-bottom"><Show when={usageError()}>{message => <UsageError message={message()} />}</Show><Show when={opencodeGoBadge()}>{badge => <LimitBadge clock={usageClock()} refreshing={refreshingUsage("opencodeGo")} onRefresh={() => refreshUsage("opencodeGo")} label="OpenCode Go" provider="opencode" detail={badge().detail} remainingPercent={badge().window.remainingPercent} resetAt={badge().window.resetAt} stale={badge().error} />}</Show><Show when={anthropicUsage()}>{entry => <LimitBadge clock={usageClock()} refreshing={refreshingUsage("anthropic")} onRefresh={() => refreshUsage("anthropic")} label="Anthropic" provider="anthropic" remainingPercent={entry().usage.remainingPercent} resetAt={entry().usage.resetAt} stale={entry().error} />}</Show><Show when={codexUsage()}>{entry => <LimitBadge clock={usageClock()} refreshing={refreshingUsage("codex")} onRefresh={() => refreshUsage("codex")} label="Codex" provider="openai" remainingPercent={entry().usage.remainingPercent} resetAt={entry().usage.resetAt} stale={entry().error} />}</Show><Show when={opencodexUsage()}>{entry => <OpencodexBadges usage={entry().usage} stale={entry().error} clock={usageClock()} refreshing={refreshingUsage("opencodex")} onRefresh={() => refreshUsage("opencodex")} />}</Show></div>);

    return (<ResizableSidebar compact={!panelOpen()}>{renderNavigation()}{renderSessionPanel()}{renderUsageBadges()}</ResizableSidebar>);
  };

  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<Rerun on={chatViewKey}>{(_key) => <ChatView transcripts={transcriptCache} onNotice={(title, message) => addNotice({ title, message })} transcriptActions={<div class="transcript-actions">{agentsIndicator()}{sidepaneButton()}</div>} agentHostLabel={activeHostId() === "local" ? localHostLabel() : required(settings()).hosts.find(host => host.id === activeHostId())?.name ?? activeHostId()} transport={transport()}  state={composerView.state()} messages={chatSession().messages} debug={debugView(required(settings()))} {...composerView.agentProps()} refreshError={chatSession().error} capabilityErrors={chatSession().capabilityErrors} capabilitiesLoading={chatSession().capabilitiesLoading} onRetryCapabilities={chatSession().retryCapabilities} modelAliases={modelVisibility.aliases(activeHostId())} models={composerView.models()} commands={chatCommands()} thinkingLevels={composerView.thinkingLevels()} widgets={chatWidgets()} statuses={composerView.statuses()} projectCwd={projectCwd()} controlsDisabled={!connected()} draft={composerState().composerDraft} onDraftChange={draftChangeFor(activeConversationKey(), transport())} draftSelection={drafts.selectionFor(transport())} onDraftSelectionChange={selection => drafts.setSelection(transport(), selection)} focusRequest={mainComposerFocusRequest()} queueHoldRequest={mainQueueHoldRequest()} onActivate={() => setActivePane("main")} uploads={composerState().composerUploads} onUploadsChange={uploadsChangeFor(transport())} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abortInteraction} onOpenTerminal={() => toggleComposerTerminal("main", { sessionKey: activeConversationKey(), cwd: projectCwd(), hostId: activeHostId() })} hosts={hostChoices(required(settings()))} onChooseHost={hostId => void chooseChatHost(hostId)} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onBranch={branch} onFork={message => branch(message, "fork")} forkSourceName={forkSourceName()} forkPoints={forkPoints()} onOpenForkSource={openForkSource} revealEntryId={revealEntryId()} onEntryRevealed={entryRevealed} onAgent={setAgent} onModel={setModel} onToggleFastMode={() => transport().promptControls.toggle(composerControls.statuses(statuses(), composerControls.state(chatSession().state).model))} onThinking={setThinking} />}</Rerun>);

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
          focusRequest={splitComposerFocusRequest()} queueHoldRequest={splitQueueHoldRequest()} onActivate={() => { if (currentPane()) setActivePane("split"); }}
          onOpenTerminal={() => { const current = currentPane();

            if (current) toggleComposerTerminal("split", { sessionKey: splitConversationKey(current), cwd: current.session.cwd, hostId: current.session.hostId ?? "local" }); }}
          onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs}
          onReleaseTransport={releaseSplitTransport} initialPrompt={pane.request?.initialPrompt} initialImages={pane.request?.initialImages}
          onInitialClaim={() => sidepane.finishOpening(pane.key)} onReady={() => finishOpening({ value: "opened" })}
          onFailed={(cause, unseen) => { finishOpening({ cancelled: true }); if (unseen) addNotice({ title: `Could not start “${pane.session.name}”`, message: cause instanceof Error ? cause.message : String(cause) }); }}
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

    const noteFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;

      if (target?.closest(".terminal-panel-container")) terminals.noteFocus("terminal");
      else if (target?.closest("piop-composer-field")) terminals.noteFocus(target.closest(".split-chat") ? "split" : "main");
    };

    return (<div class="chat-workspace" hidden={view() !== "chat"} onFocusIn={noteFocus}>
      <DraftRecovery drafts={drafts} conversationKey={activeConversationKey()} onSelect={selectSession} />
      {renderChatPanes()}
      {terminals.prepareTerminal() && terminals.ready() && <div class="terminal-panel-container" classList={{ "terminal-panel-container-preparing": !terminalOpen() }} inert={!terminalOpen()} aria-hidden={!terminalOpen()}><Rerun on={terminalViewKey}>{(_key) => <TerminalView visible={terminalOpen() && view() === "chat"} focusOnShow={() => !terminals.focusedComposer()} ownershipRequired={!terminals.owned()} onTakeOwnership={terminals.takeOwnership} cwd={terminalLocationState().terminalCwd} terminals={terminals.state.sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={terminals.state.activeTerminal.id} output={terminals.state.activeTerminal.output} outputEnd={terminals.state.activeTerminal.outputEnd} snapshot={terminals.state.activeTerminal.snapshot} snapshotEnd={terminals.state.activeTerminal.snapshotEnd} started={terminals.state.activeTerminal.started} exited={terminals.state.activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} inputDraft={terminals.state.activeTerminal.inputDraft} onDraft={terminals.updateDraft} onData={terminals.write} onResize={terminals.resize} onSnapshot={((sessionId: string, terminalId: string, generation?: string) => (value: string, outputEnd: number) => terminals.saveTerminalSnapshot(sessionId, terminalId, value, outputEnd, generation))(terminals.terminalSessionId(), terminals.state.activeTerminal.id, terminals.state.activeTerminal.generation)} onDelete={deleteTerminal} onClose={terminals.close} />}</Rerun></div>}
    </div>);
  };

  const renderSettingsView = () => (view() === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount()} settings={required((settings()))} sessions={sessions()} onSave={saveSettings} onDirtyChange={setSettingsDirty} onBack={() => { if (canLeaveSettings()) setView("chat"); }} />);

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
  const auxiliaryTab = (hostId: string, sessionId: string) => sidepane.tabs().find(tab => tab.key === `${hostId}:${sessionId}`);
  const auxiliaryChats: AuxiliaryChats = {
    listed: (hostId, sessionId) => Boolean(listedSession(hostId, sessionId)?.auxiliaryParentId || auxiliaryTab(hostId, sessionId)),
    open: (hostId, sessionId) => {
      const session = listedSession(hostId, sessionId) ?? auxiliaryTab(hostId, sessionId)?.session;
      if (session) { sidepane.openAuxiliary(session); setActivePane("split"); }
    },
  };
  const [archivedLink, setArchivedLink] = createSignal<ArchivedLink>();
  const [openWhenListed, setOpenWhenListed] = createSignal<{ hostId: string; sessionId: string }>();
  createDependencyEffect(() => {
    const target = openWhenListed();
    const session = target && listedSession(target.hostId, target.sessionId);

    if (session) { setOpenWhenListed(undefined); selectSession(session); }
  }, () => [openWhenListed(), sessions()]);
  let linkClick = 0;
  const sessionLinks: SessionLinks = {
    name: (hostId, sessionId) => listedSession(hostId, sessionId)?.name,
    open: (hostId, sessionId, anchor) => {
      const click = ++linkClick;
      const session = listedSession(hostId, sessionId);

      setArchivedLink(undefined);

      if (session) { selectSession(session); return; }
      void locateConversation(sessionId, hostId).then(location => {
        if (click !== linkClick) return;

        const name = anchor.textContent?.trim() || "This chat";

        if (!location.archived) addNotice({ title: "Could not open the chat", message: "It is not in the chat list." });
        else if (location.auxiliary) addNotice({ title: "Could not open the chat", message: `“${name}” is archived and can not be restored.` });
        else setArchivedLink({ hostId, sessionId, sessionPath: location.sessionPath, name, anchor });
      }, reason => { if (click === linkClick) addNotice({ title: "Could not open the chat", message: reason instanceof Error ? reason.message : String(reason) }); });
    },
  };
  const renderArchivedLinkPopup = () => <Show when={archivedLink()} keyed>{link => <ArchivedLinkPopup link={link} onClose={() => setArchivedLink(undefined)} onRestored={() => { setArchivedLink(undefined); setOpenWhenListed({ hostId: link.hostId, sessionId: link.sessionId }); void syncSessionIndex(); }} />}</Show>;

  return <SessionLinkContext.Provider value={sessionLinks}><AuxiliaryChatsContext.Provider value={auxiliaryChats}><SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div role="region" aria-label={workspaceLabel()} class={`app ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    {!mobileSidebarOpen() && renderMobileSidebarToggle()}
    {renderMobileSidebarBackdrop()}
    <Show when={view() !== "settings"}>{renderSidebar()}</Show>
    <ComposerPluginsContext.Provider value={pluginPane.composers}><TranscriptPluginsContext.Provider value={pluginPane.transcripts}><transcriptCache.Host />{renderChatWorkspace()}</TranscriptPluginsContext.Provider></ComposerPluginsContext.Provider>
    {renderSettingsView()}
    <FindInPage selector=".chat-panes > .main-chat > .chat-shell" scopeKey={activeConversationKey()} onActivate={() => setActivePane("main")} active={activePane() === "main" || !hasSidePane()} enabled={view() === "chat"} />
    {renderSubagentFind()}
    {renderSplitFind()}
    {view() === "settings" && <FindInPage selector=".settings-shell" scopeKey="settings" />}
    {renderToastStack()}
    {renderArchivedLinkPopup()}
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
