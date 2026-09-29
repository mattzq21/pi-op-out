import { Key, Rerun } from "@solid-primitives/keyed";
import { ArrowLeft, Bug, FolderPlus, GitBranch, MessageSquare, Server, Settings } from "lucide-solid";
import { createMemo, createSignal, Show } from "solid-js";
import { createAppConversations } from "./appConversations";
import { AppLoading, LimitBadge, splitConversationKey } from "./appSupport";
import { ChatView } from "./components/ChatView";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { ConversationQuestionsContext, createConversationQuestions } from "./components/ConversationQuestions";
import { isAskUserRequest } from "./components/AskUserDialog";
import { FindInPage } from "./components/FindInPage";
import { IconButton } from "./components/IconButton";
import { LocalSettingsView } from "./components/LocalSettingsView";
import { ProjectDialog } from "./components/ProjectDialog";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { SessionPanel } from "./components/SessionPanel";
import { SplitChatPane } from "./components/SplitChatPane";
import { SubagentPane } from "./components/SubagentPane";
import { SubagentNavigationContext } from "./lib/subagentNavigation";
import { TerminalView } from "./components/TerminalView";
import { FileWorkspace } from "./components/FileWorkspace";
import { WorktreeDialog } from "./components/WorktreeDialog";
import { isMobile } from "./lib/platform";
import { useAppKeyboard } from "./useAppKeyboard";
import { useAppUsage } from "./useAppUsage";
export { formatCodexReset, normalizeCodexUsage, normalizeOpencodeGoUsage, usageWindowsDescription } from "./appSupport";
declare const __PIOP_DEVELOPMENT_BRANCH__: string;

export default function App() {
  const [view, setView] = createSignal<"chat" | "settings">("chat");
  const [panelOpen, setPanelOpen] = createSignal(!window.matchMedia("(max-width: 700px)").matches);
  const [query, setQuery] = createSignal("");
  const [createGroupRequest, setCreateGroupRequest] = createSignal(0);
  const handleCreateGroup = () => setCreateGroupRequest(0);
  const [notices, setNotices] = createSignal<Array<{ id: string; title: string; message: string }>>([]);
  const addNotice = (notice: { title: string; message: string }) => setNotices(current => [...current.slice(-9), { ...notice, id: crypto.randomUUID() }]);
  const {
    runtimePool, transport, settingsController, terminals, extensions,
    sessions, sidebarSessions, sessionProjects, runningSessions, unseenSessions, pendingSettingsCount, gitDiffs, chatSession,
    activeConversationKey, activeHostId, activeCwd, connected, error, isGitRepository, projectCwd,
    splitPane, splitSessionId, subagentPane, hasSidePane, activePane, setActivePane,
    mainComposerFocusRequest, splitComposerFocusRequest, setMainComposerFocusRequest, setSplitComposerFocusRequest,
    composerState, draftChangeFor, uploadsChangeFor, uploadsFor, setComposerUploads, setComposerDraft,
    newSession, startNewSession, selectSession, sessionAction, clearChatProject, chooseChatProject,
    send, branch, forkAndForget, setAgent, setModel, setThinking, toggleFastMode,
    abortInteraction, pauseInteraction, resumeInteraction, reconnectMain, isReconnecting, dismissError,
    openSubagent, closeSplitPane, releaseSplitTransport, changeSplitSession,
    projectOpen, openProject, cancelProject, resolveHomeDirectory, canLeaveSettings, toggleTerminal,
    renameSession, renameConversation, relocatingSession, relocationError, relocateConversation,
    worktreeTarget, requestWorktree, cancelWorktree, createWorktree, deleteWorktree, chatModels, chatCommands
  } = createAppConversations({ view, setView, setPanelOpen, addNotice });
  const { settings, settingsSaving, debugModeSaving, settingsDirty, setSettingsDirty, saveSettings, toggleDebugMode } = settingsController;
  const { terminalOpen, terminalSessionId, terminalLocationState, startTerminal, addTerminal, selectTerminal, saveTerminalSnapshot, deleteTerminal } = terminals;
  const { dialogs, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, respondToBtw } = extensions;
  const { codexUsage, opencodeGoBadge, usageClock } = useAppUsage(transport);
  useAppKeyboard({ settings, activePane, splitPane, canLeaveSettings, setView, setPanelOpen, newSession, toggleTerminal, toggleDebugMode, setSplitComposerFocusRequest, setMainComposerFocusRequest, settingsDirty, view, terminalOpen, closeTerminal: terminals.hide });
  const activeDialog = createMemo(() => dialogs().find((item) => !isAskUserRequest(item.request)));
  const questionContext = createConversationQuestions(dialogs, extensions.dismissDialog);
  const chatAgentProps = extensions.agentProps;
  const chatWidgets = extensions.visibleWidgets;
  const renderMobileSidebarBackdrop = () => (panelOpen() && view() === "chat" && <button class="mobile-sidebar-backdrop" aria-label="Close conversations" onClick={() => setPanelOpen(false)} />);
  const renderSidebar = () => {
    const renderNavigation = () => (<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="New session group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><IconButton label={(settings())!.debugMode ? "Disable debug mode" : "Enable debug mode"} class={(settings())!.debugMode ? "active" : ""} disabled={debugModeSaving() || settingsSaving()} onClick={toggleDebugMode}><Bug size={18} /></IconButton><IconButton label={view() === "settings" ? "Go back" : "Settings"} class={view() === "settings" ? "active" : ""} onClick={() => { if (view() !== "settings") { setView("settings"); return; } if (canLeaveSettings()) setView("chat"); }}>{view() === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton>{isMobile && <IconButton label="Host" onClick={() => { if (canLeaveSettings()) window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}</nav>);
    const renderSessionPanel = () => (view() === "chat" && panelOpen() && <SessionPanel sessionProjects={sessionProjects} sessions={sidebarSessions()} activeId={chatSession().state.sessionId} activeHostId={activeHostId()} runningSessions={runningSessions()} unseenSessions={unseenSessions()} query={query()} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => void startNewSession(false, group)} onCreateWorktree={(cwd, hostId) => requestWorktree({ cwd, hostId, transport: transport() })} onDeleteWorktree={deleteWorktree} createGroupRequest={createGroupRequest()} onCreateGroupHandled={handleCreateGroup} />);
    const renderUsageBadges = () => (<div class="rail-bottom">{opencodeGoBadge() && <LimitBadge clock={usageClock()} label="OpenCode Go" prefix="Go " go detail={(opencodeGoBadge())!.detail} remainingPercent={(opencodeGoBadge())!.window.remainingPercent} resetAt={(opencodeGoBadge())!.window.resetAt} />}{codexUsage() !== undefined && <LimitBadge clock={usageClock()} label="Codex" remainingPercent={(codexUsage())!.remainingPercent} resetAt={(codexUsage())!.resetAt} />}</div>);
    return (<ResizableSidebar compact={view() === "settings" || !panelOpen()}><div class="rail-branch" title={`piop development branch: ${__PIOP_DEVELOPMENT_BRANCH__}`}><GitBranch size={13} /><span>{__PIOP_DEVELOPMENT_BRANCH__}</span></div>{renderNavigation()}{renderSessionPanel()}{renderUsageBadges()}</ResizableSidebar>);
  };
  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<Rerun on={() => activeConversationKey()}>{(_key) => <ChatView transport={transport()}  state={chatSession().state} messages={chatSession().messages} gitDiffs={gitDiffs()} debug={(settings())!.debugMode} {...chatAgentProps()} models={chatModels()} commands={chatCommands()} thinkingLevels={chatSession().thinkingLevels} widgets={chatWidgets()} statuses={extensions.visibleStatuses()} projectCwd={projectCwd()} filesCwd={activeCwd()} controlsDisabled={!connected()} selectionBtw draft={composerState().composerDraft} onDraftChange={draftChangeFor(activeConversationKey(), transport())} focusRequest={mainComposerFocusRequest()} onActivate={() => setActivePane("main")} uploads={composerState().composerUploads} onUploadsChange={uploadsChangeFor(transport())} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abortInteraction} onPause={pauseInteraction} onResume={resumeInteraction} onOpenTerminal={() => { setActivePane("main"); terminals.openFor({ sessionKey: activeConversationKey(), cwd: projectCwd(), hostId: activeHostId() }); }} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onBranch={branch} onForkAndForget={isGitRepository() === false && projectCwd() ? forkAndForget : undefined} onCreateWorktree={isGitRepository() && projectCwd() ? (message) => requestWorktree({ cwd: (projectCwd())!, hostId: activeHostId(), message, transport: transport() }) : undefined} onAgent={setAgent} onModel={setModel} onToggleFastMode={toggleFastMode} onThinking={setThinking} />}</Rerun>);
      const renderSplitChatPane = () => (<Show when={splitPane()}><Rerun on={() => splitPane()?.key}>{(_key) => {
        const pane = splitPane()!;
        const currentPane = () => splitPane()?.key === pane.key ? splitPane() : undefined;
        return <SplitChatPane runtimePool={runtimePool()} uploadsFor={uploadsFor} onUploadsChange={setComposerUploads}
          session={currentPane()?.session ?? pane.session} settings={settings()!} draft={composerState().splitComposerDraft}
          onDraftChange={(update) => { const current = currentPane(); if (current) setComposerDraft(splitConversationKey(current), update); }}
          focusRequest={splitComposerFocusRequest()} onActivate={() => { if (currentPane()) setActivePane("split"); }}
          onOpenTerminal={() => { const current = currentPane(); if (!current) return; setActivePane("split"); terminals.openFor({ sessionKey: splitConversationKey(current), cwd: current.session.cwd, hostId: current.session.hostId ?? "local" }); }}
          onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs}
          onReleaseTransport={releaseSplitTransport} onSessionChange={(next, owner) => changeSplitSession(pane.key, next, owner)} forkFrom={pane.btw?.forkFrom} initialPrompt={pane.btw?.task} initialImages={pane.btw?.images}
          onReady={pane.btw ? () => respondToBtw(pane.btw!.requestId, { value: "opened" }) : undefined}
          onFailed={pane.btw ? () => respondToBtw(pane.btw!.requestId, { cancelled: true }) : undefined}
          onClose={() => { if (currentPane()) closeSplitPane(); }} />;
      }}</Rerun></Show>);
      return (<div class={`chat-panes ${hasSidePane() ? "split" : ""}`}>
        {renderChatView()}
        {renderSplitChatPane()}
        {subagentPane() && <Rerun on={() => `${subagentPane()!.hostId}:${subagentPane()!.sessionId}`}>{(_key) => <SubagentPane target={subagentPane()!} onClose={closeSplitPane} onActivate={() => setActivePane("split")} />}</Rerun>}
      </div>);
    };
    return (<div class="chat-workspace" hidden={view() !== "chat"}>
      <FileWorkspace sessionKey={activeConversationKey()}>{renderChatPanes()}</FileWorkspace>
      {terminalOpen() && <Rerun on={terminals.viewKey}>{(_key) => <TerminalView  cwd={terminalLocationState().terminalCwd} terminals={terminals.sessionTerminals().tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={terminals.activeTerminal().id} output={terminals.activeTerminal().output} outputEnd={terminals.activeTerminal().outputEnd} snapshot={terminals.activeTerminal().snapshot} snapshotEnd={terminals.activeTerminal().snapshotEnd} started={terminals.activeTerminal().started} exited={terminals.activeTerminal().exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={terminals.write} onResize={terminals.resize} onSnapshot={((sessionId: string, terminalId: string) => (value: string, outputEnd: number) => saveTerminalSnapshot(sessionId, terminalId, value, outputEnd))(terminalSessionId(), terminals.activeTerminal().id)} onDelete={deleteTerminal} onClose={terminals.close} />}</Rerun>}
    </div>);
  };
  const renderSettingsView = () => (view() === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount()} settings={(settings())!} sessions={sessions()} onSave={saveSettings} onDirtyChange={setSettingsDirty} />);
  const renderToastStack = () => (<Show when={error() || notices().length > 0}><div class="toast-stack">
      {error() && <div class="error-toast" role="alert"><strong>piop could not connect</strong><span>{(error())!}</span><button onClick={reconnectMain} disabled={isReconnecting()}>Retry</button><button aria-label="Dismiss connection error" onClick={dismissError}>×</button></div>}
      {<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}
    </div></Show>);
  const renderExtensionDialog = () => (activeDialog() && !projectOpen() && !renameSession() && !relocatingSession() && !worktreeTarget() && <Rerun on={() => activeDialog()?.queueId}>{(_key) => <ExtensionDialog request={activeDialog()!.request} owner={activeDialog()!.owner} onRespond={(response) => extensions.respondToDialog(activeDialog()!, response)} />}</Rerun>);
  const renderProjectDialog = () => (projectOpen() && <ProjectDialog initialPath={projectCwd() ?? ""} hosts={(settings())!.hosts} initialHostId={activeHostId()} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport().listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={cancelProject} />);
  const renderRelocationDialog = () => (relocatingSession() && <Rerun on={() => relocatingSession()?.id}>{(_key) => <ExtensionDialog request={{ type: "extension_ui_request", id: `relocate-${(relocatingSession())!.id}`, method: "input", title: "Locate conversation project", message: `The original project directory no longer exists: ${(relocatingSession())!.cwd}. Enter its new location to open this conversation.`, error: relocationError(), placeholder: "Replacement project directory", prefill: sessions().find((session) => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId() && session.cwdExists !== false)?.cwd || "" }} onRespond={relocateConversation} />}</Rerun>);
  const renderWorktreeDialog = () => (worktreeTarget() && <WorktreeDialog projectPath={(worktreeTarget())!.cwd} fromProject={!(worktreeTarget())!.message} beforePrompt={(worktreeTarget())!.message?.role === "user"} onCancel={cancelWorktree} onCreate={(name, onSetup) => createWorktree((worktreeTarget())!, name, onSetup)} />);
  const renderSubagentFind = () => subagentPane() && <FindInPage selector=".subagent-pane .chat-shell" scopeKey={`${subagentPane()!.hostId}:${subagentPane()!.sessionId}`} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />;
  return <SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div class={`app dark ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    <div class="mobile-navigation"><button aria-label="Toggle conversations" aria-expanded={panelOpen() && view() === "chat"} onClick={() => { if (canLeaveSettings()) { setView("chat"); setPanelOpen((value) => !value); } }}>☰</button></div>
    {renderMobileSidebarBackdrop()}
    {import.meta.env.MODE === "e2e" && <div class="e2e-bridge"><textarea id="pi-e2e-responses" aria-label="E2E responses" placeholder="E2E responses" /><textarea id="pi-e2e-calls" aria-label="E2E calls" placeholder="E2E calls" /></div>}
    {renderSidebar()}
    <ConversationQuestionsContext.Provider value={questionContext}>{renderChatWorkspace()}</ConversationQuestionsContext.Provider>
    {renderSettingsView()}
    <FindInPage selector=".chat-panes > .chat-shell" scopeKey={activeConversationKey()} onActivate={() => setActivePane("main")} active={activePane() === "main" || !hasSidePane()} enabled={view() === "chat"} />
    {renderSubagentFind()}
    {splitPane() && <Rerun on={() => splitSessionId()}>{(_key) => <FindInPage selector=".split-chat .chat-shell" scopeKey={splitSessionId()} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />}</Rerun>}
    {view() === "settings" && <FindInPage selector=".settings-shell" scopeKey="settings" />}
    {renderToastStack()}
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession() && <Rerun on={() => renameSession()?.session.id}>{(_key) => <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: (renameSession())!.session.name }} onRespond={renameConversation} />}</Rerun>}
    {renderRelocationDialog()}
    {renderWorktreeDialog()}
  </div>)}</SubagentNavigationContext.Provider>;
}
