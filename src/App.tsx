import { required } from "./lib/required";
import { Key,Rerun } from "@solid-primitives/keyed";
import { Archive,ArrowLeft,Bug,FolderPlus,GitBranch,MessageSquare,Server,Settings } from "lucide-solid";
import { batch,lazy,Show } from "solid-js";
import { createAppConversations } from "./appConversations";
import { AppLoading,LimitBadge,splitConversationKey } from "./appSupport";
import { ConversationQuestionsContext } from "./components/ConversationQuestions";
import { FindInPage } from "./components/FindInPage";
import { IconButton } from "./components/IconButton";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { SessionPanel } from "./components/SessionPanel";
import { ArchivedSessionPanel } from "./components/ArchivedSessionPanel";
import { MissingDirectoryDialog } from "./components/MissingDirectoryDialog";
import { hasVisibleText } from "./lib/content";
import { NativeTransport,resolveBranchGroup } from "./lib/nativeTransport";
import { isMobile } from "./lib/platform";
import { beginBranching, isBranching } from "./lib/branchActivity";
import { SubagentNavigationContext } from "./lib/subagentNavigation";
import type { ChatMessage, SessionSummary } from "./types";

export { formatCodexReset,normalizeCodexUsage,normalizeOpencodeGoUsage,usageWindowsDescription } from "./appSupport";

declare const __PIOP_DEVELOPMENT_BRANCH__: string;

const LocalSettingsView = lazy(() => import("./components/LocalSettingsView").then(module => ({ default: module.LocalSettingsView })));

const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));

const ChatView = lazy(() => import("./components/ChatView").then(module => ({ default: module.ChatView })));

const ExtensionDialog = lazy(() => import("./components/ExtensionDialog").then(module => ({ default: module.ExtensionDialog })));

const ProjectDialog = lazy(() => import("./components/ProjectDialog").then(module => ({ default: module.ProjectDialog })));

const SplitChatPane = lazy(() => import("./components/SplitChatPane").then(module => ({ default: module.SplitChatPane })));

const SubagentPane = lazy(() => import("./components/SubagentPane").then(module => ({ default: module.SubagentPane })));

const WorktreeDialog = lazy(() => import("./components/WorktreeDialog").then(module => ({ default: module.WorktreeDialog })));

export default function App() {
 const { archiveReplacedSession, isArchiving, missingDirectoryDialog, archivesOpen, setArchivesOpen, runtimePool, transport, view, setView, activeConversationKey, chatViewKey, runningSessions, unseenSessions, pendingSettingsCount, gitDiffs, chatSession, sessions, settings, settingsSaving, debugModeSaving, setSettingsDirty, panelOpen, setPanelOpen, query, setQuery, connected, error, setError, createGroupRequest, setCreateGroupRequest, handleCreateGroup, activeHostId, isGitRepository, codexUsage, usageClock, opencodeGoBadge, setDialogs, notices, setNotices, addNotice, queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs, releaseSplitTransport, statuses, renameSession, setRenameSession, projectOpen, setProjectOpen, worktreeTarget, setWorktreeTarget, projectOpenRef, uploadsByTransport, setComposerDraft, setComposerUploads, splitPane, setSplitPane, subagentPane, hasSidePane, mainComposerFocusRequest, splitComposerFocusRequest, activePane, setActivePane, terminals, terminalOpen, terminalLocationState, startTerminal, addTerminal, selectTerminal, deleteTerminal, reconnectPending, splitSessionId, composerState, terminalViewKey, syncSessionIndex, composerControls, resolveHomeDirectory, send, respondToReview, closeSplitPane, openSubagent, canLeaveSettings, rekeyConversationUi, createWorktree, deleteWorktree, branch, forkAndForget, startNewSession, newSession, clearChatProject, selectSession, setModel, setThinking, abortInteraction, pauseInteraction, resumeInteraction, saveSettings, setAgent, openProject, chooseChatProject, sessionAction, draftChangeFor, uploadsChangeFor, toggleComposerTerminal, toggleDebugMode, reconnectMain, extensionStateIsCurrent, activeDialog, questionContext, projectCwd, mobileSidebarOpen, sidebar, chatAgentProps, chatModels, chatCommands, chatWidgets } = createAppConversations(() => { void ChatView.preload().catch(() => undefined); });


  const renderMobileSidebarBackdrop = () => (panelOpen() && view() === "chat" && <button class="mobile-sidebar-backdrop" aria-label="Close conversations" onClick={() => setPanelOpen(false)} />);

  const branchIntoWorktree = async (message: ChatMessage) => {
    const cwd = projectCwd();

    if (!cwd || isBranching()) return;
    const target = { cwd, hostId: activeHostId(), message, transport: transport() };
    const finish = beginBranching();

    try { await createWorktree(target, crypto.randomUUID().slice(0, 8)); }
    catch (reason) { addNotice({ title: "Could not branch conversation", message: String(reason) }); }
    finally { finish(); }
  };

  const renderMobileSidebarToggle = () => <button type="button" class="mobile-sidebar-toggle" aria-label="Toggle conversations" aria-expanded={mobileSidebarOpen()} onClick={() => { if (canLeaveSettings()) { const open = !mobileSidebarOpen(); setView("chat"); setPanelOpen(open); } }}>☰</button>;

  const renderArchiveButton = () => {
    const active = () => archivesOpen() && view() === "chat";

    return <IconButton label={active() ? "Show regular sessions" : "Show archived sessions"} class={active() ? "active" : ""} aria-pressed={active()} onClick={() => {
      if (!canLeaveSettings()) return;
      setArchivesOpen(!active()); setView("chat"); setPanelOpen(true);
    }}><Archive size={18} /></IconButton>;
  };

  const renderSidebar = () => {
    const renderNavigation = () => (<nav><IconButton label="New conversation" onClick={newSession}><MessageSquare size={18} /></IconButton><IconButton label="Group" onClick={() => { if (!canLeaveSettings()) return; setView("chat"); setArchivesOpen(false); setPanelOpen(true); setQuery(""); setCreateGroupRequest((request) => request + 1); }}><FolderPlus size={18} /></IconButton><IconButton label={required((settings())).debugMode ? "Disable debug mode" : "Enable debug mode"} class={required((settings())).debugMode ? "active" : ""} disabled={debugModeSaving() || settingsSaving()} onClick={toggleDebugMode}><Bug size={18} /></IconButton>{renderArchiveButton()}<IconButton label={view() === "settings" ? "Go back" : "Settings"} class={view() === "settings" ? "active" : ""} onClick={() => { if (view() !== "settings") { setView("settings");

        return; }

      if (canLeaveSettings()) setView("chat"); }}>{view() === "settings" ? <ArrowLeft size={19} /> : <Settings size={19} />}</IconButton>{isMobile && <IconButton label="Host" onClick={() => { window.dispatchEvent(new Event("piop-mobile-disconnect")); }}><Server size={18} /></IconButton>}{panelOpen() && view() === "chat" && renderMobileSidebarToggle()}</nav>);

    const renderSessionPanel = () => (view() === "chat" && panelOpen() && <Show when={archivesOpen()} fallback={<SessionPanel transport={transport()} settings={required(settings())} isArchiving={isArchiving} debug={settings()?.debugMode} sidebar={sidebar} activeId={chatSession().state.sessionId} activeHostId={activeHostId()} runningSessions={runningSessions()} unseenSessions={unseenSessions()} query={query()} onQuery={setQuery} onSelect={selectSession} onAction={sessionAction} onNewChat={(group) => { const owner = transport(); void resolveBranchGroup(group).then((target) => { if (transport() === owner) return startNewSession(false, target); }).catch((reason) => addNotice({ title: "Could not open branch", message: String(reason) })); }} onCreateWorktree={(cwd, hostId) => setWorktreeTarget({ cwd, hostId, transport: transport() })} onDeleteWorktree={deleteWorktree} createGroupRequest={createGroupRequest()} onCreateGroupHandled={handleCreateGroup} />}><ArchivedSessionPanel /></Show>);
    const renderUsageBadges = () => (<div class="rail-bottom">{opencodeGoBadge() && <LimitBadge clock={usageClock()} label="OpenCode Go" prefix="Go " go detail={required((opencodeGoBadge())).detail} remainingPercent={required((opencodeGoBadge())).window.remainingPercent} resetAt={required((opencodeGoBadge())).window.resetAt} />}{codexUsage() !== undefined && <LimitBadge clock={usageClock()} label="Codex" remainingPercent={required((codexUsage())).remainingPercent} resetAt={required((codexUsage())).resetAt} />}</div>);

    return (<ResizableSidebar compact={view() === "settings" || !panelOpen()}><div class="rail-branch" title={`piop development branch: ${__PIOP_DEVELOPMENT_BRANCH__}`}><GitBranch size={13} /><span>{__PIOP_DEVELOPMENT_BRANCH__}</span></div>{renderNavigation()}{renderSessionPanel()}{renderUsageBadges()}</ResizableSidebar>);
  };

  const renderChatWorkspace = () => {
    const renderChatPanes = () => {
      const renderChatView = () => (<Rerun on={chatViewKey}>{(_key) => <ChatView transport={transport()}  state={composerControls.state(chatSession().state)} messages={chatSession().messages} gitDiffs={gitDiffs()} debug={required((settings())).debugMode} {...chatAgentProps()} models={chatModels()} commands={chatCommands()} thinkingLevels={composerControls.thinkingLevels(chatSession().thinkingLevels)} widgets={chatWidgets()} statuses={composerControls.statuses(extensionStateIsCurrent() ? statuses() : {})} projectCwd={projectCwd()} controlsDisabled={!connected()} draft={composerState().composerDraft} onDraftChange={draftChangeFor(activeConversationKey(), transport())} focusRequest={mainComposerFocusRequest()} onActivate={() => setActivePane("main")} uploads={composerState().composerUploads} onUploadsChange={uploadsChangeFor(transport())} onSend={send} onChangePending={(id, behavior) => transport().changePendingMessage(id, behavior)} onAbort={abortInteraction} onPause={pauseInteraction} onResume={resumeInteraction} onOpenTerminal={() => toggleComposerTerminal("main", { sessionKey: activeConversationKey(), cwd: projectCwd(), hostId: activeHostId() })} onOpenProject={chooseChatProject} onClearProject={clearChatProject} onProjectBranch={(cwd) => openProject(cwd, activeHostId(), true)} onBranch={branch} canRollback={sessions().some(session => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId() && session.projectKind === "worktree")} onForkAndForget={forkAndForget} onCreateWorktree={isGitRepository() && projectCwd() ? (message) => void branchIntoWorktree(message) : undefined} onAgent={setAgent} onModel={setModel} onToggleFastMode={() => transport().promptControls.toggle(composerControls.statuses(statuses()))} onThinking={setThinking} />}</Rerun>);

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

        return <SplitChatPane runtimePool={runtimePool()} uploadsFor={(owner) => uploadsByTransport().get(owner) ?? []} onUploadsChange={setComposerUploads}
          session={currentPane()?.session ?? pane.session} settings={required(settings())} draft={composerState().splitComposerDraft}
          onDraftChange={(update) => { const current = currentPane();

            if (current) setComposerDraft(splitConversationKey(current), update); }}
          focusRequest={splitComposerFocusRequest()} onActivate={() => { if (currentPane()) setActivePane("split"); }}
          onOpenTerminal={() => { const current = currentPane();

            if (current) toggleComposerTerminal("split", { sessionKey: splitConversationKey(current), cwd: current.session.cwd, hostId: current.session.hostId ?? "local" }); }}
          onDialogRequest={queueExtensionDialog} onDialogResolved={resolveExtensionDialog} onDialogTransportClosed={closeTransportDialogs}
          onReleaseTransport={releaseSplitTransport} onArchiveOriginal={archiveReplacedSession} onSessionChange={changeSession} freshReview={Boolean(pane.review)} initialPrompt={pane.review?.task} initialImages={pane.review?.images}
          onReady={pane.review ? () => respondToReview(required(pane.review).requestId, { value: "opened" }) : undefined}
          onMessageMain={pane.review?.messageMain}
          onFailed={pane.review ? () => respondToReview(required(pane.review).requestId, { cancelled: true }) : undefined}
          onClose={() => { if (currentPane()) closeSplitPane(); }} />;
      }}</Rerun></Show>);

      return (<div class={`chat-panes ${hasSidePane() ? "split" : ""}`}>
        <div style={{ display: "contents" }} inert={sessions().some(session => session.id === chatSession().state.sessionId && (session.hostId ?? "local") === activeHostId() && isArchiving(session))}>
          {renderChatView()}
        </div>
        {renderSplitChatPane()}
        <Show when={subagentPane()} keyed>{(target) => <SubagentPane target={target} onClose={closeSplitPane} onActivate={() => setActivePane("split")} />}</Show>
      </div>);
    };

    return (<div class="chat-workspace" hidden={view() !== "chat"}>
      {renderChatPanes()}
      {terminalOpen() && terminals.ready() && <Rerun on={terminalViewKey}>{(_key) => <TerminalView ownershipRequired={!terminals.owned()} onTakeOwnership={terminals.takeOwnership} cwd={terminalLocationState().terminalCwd} terminals={terminals.state.sessionTerminals.tabs.map((terminal, index) => ({ id: terminal.id, label: index === 0 ? "Terminal" : `Terminal ${index + 1}` }))} activeId={terminals.state.activeTerminal.id} output={terminals.state.activeTerminal.output} outputEnd={terminals.state.activeTerminal.outputEnd} snapshot={terminals.state.activeTerminal.snapshot} snapshotEnd={terminals.state.activeTerminal.snapshotEnd} started={terminals.state.activeTerminal.started} exited={terminals.state.activeTerminal.exited} onAdd={addTerminal} onSelect={selectTerminal} onStart={startTerminal} onData={terminals.write} onSnapshot={((sessionId: string, terminalId: string, generation?: string) => (value: string, outputEnd: number) => terminals.saveTerminalSnapshot(sessionId, terminalId, value, outputEnd, generation))(terminals.terminalSessionId(), terminals.state.activeTerminal.id, terminals.state.activeTerminal.generation)} onDelete={deleteTerminal} onClose={terminals.close} />}</Rerun>}
    </div>);
  };

  const renderSettingsView = () => (view() === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount()} settings={required((settings()))} sessions={sessions()} onSave={saveSettings} onDirtyChange={setSettingsDirty} />);

  const renderToastStack = () => (<Show when={error() || notices().length > 0}><div class="toast-stack">
    {error() && <div class="error-toast" role="alert"><strong>piop could not connect</strong><span>{(error())}</span><button onClick={reconnectMain} disabled={reconnectPending.current.has(transport())}>Retry</button><button aria-label="Dismiss connection error" onClick={() => setError(undefined)}>×</button></div>}
    {<Key each={notices()} by={(notice) => notice.id}>{(notice, _index) => <div class="error-toast" role="alert" ><strong>{notice().title}</strong><span>{notice().message}</span><button aria-label={`Dismiss ${notice().title}`} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice().id))}>×</button></div>}</Key>}
  </div></Show>);

  const renderExtensionDialog = () => (activeDialog() && !missingDirectoryDialog() && !projectOpen() && !renameSession() && !worktreeTarget() && <Rerun on={() => activeDialog()?.queueId}>{(_key) => <ExtensionDialog request={required(activeDialog()).request} owner={required(activeDialog()).owner} onRespond={async (response) => {
    const capturedActiveDialog = required(activeDialog());
    await capturedActiveDialog.transport.command({ type: "extension_ui_response", id: capturedActiveDialog.request.id, ...response }); setDialogs((current) => current.filter((item) => item !== capturedActiveDialog)); }} />}</Rerun>);

  const renderProjectDialog = () => (projectOpen() && <ProjectDialog localEnabled={settings()?.localEnabled} initialPath={projectCwd() ?? ""} hosts={required((settings())).hosts.filter((host) => host.enabled !== false)} initialHostId={activeHostId()} onHomeDirectory={resolveHomeDirectory} onChooseDirectory={(currentPath, hostId) => transport().listDirectories(hostId, currentPath || undefined)} onOpen={openProject} onCancel={() => { projectOpenRef.current = false; setProjectOpen(false); }} />);
  const renderWorktreeDialog = () => (worktreeTarget() && <WorktreeDialog projectPath={required((worktreeTarget())).cwd} fromProject={!required((worktreeTarget())).message} beforePrompt={required((worktreeTarget())).message?.role === "user"} onCancel={() => setWorktreeTarget(undefined)} onCreate={(name, onSetup) => createWorktree(required((worktreeTarget())), name, onSetup)} />);
  const renderSubagentFind = () => subagentPane() && <FindInPage selector=".subagent-pane .chat-shell" scopeKey={`${required(subagentPane()).hostId}:${required(subagentPane()).sessionId}`} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />;

  const renderMissingDirectoryDialog = () => missingDirectoryDialog() && <Rerun on={() => missingDirectoryDialog()}>{() => <MissingDirectoryDialog request={required(missingDirectoryDialog())} />}</Rerun>;

  return <SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div class={`app dark ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    {!mobileSidebarOpen() && renderMobileSidebarToggle()}
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
    <BranchActivity />
    {renderExtensionDialog()}
    {renderProjectDialog()}
    {renameSession() && <Rerun on={() => renameSession()?.session.id}>{(_key) => <ExtensionDialog request={{ type: "extension_ui_request", id: "rename-session", method: "input", title: "Rename conversation", prefill: required((renameSession())).session.name }} onRespond={async (response) => {
      const capturedRenameSession = renameSession(); const capturedSession = { ...chatSession() }; const capturedActiveHostId = activeHostId();

      if (response.cancelled) { setRenameSession(undefined);

        return; }

      if (response.value === undefined || !hasVisibleText(response.value)) throw new Error("Conversation name can't be empty"); const name = response.value.trim(); await required((capturedRenameSession)).transport.connect(); await required((capturedRenameSession)).transport.command({ type: "set_session_name", name });

      if (required((capturedRenameSession)).session.id === capturedSession.state.sessionId && (required((capturedRenameSession)).session.hostId ?? "local") === capturedActiveHostId) capturedSession.setState((current) => ({ ...current, sessionName: name })); await syncSessionIndex(); setRenameSession(undefined); }} />}</Rerun>}
    {renderWorktreeDialog()}
    {renderMissingDirectoryDialog()}
  </div>)}</SubagentNavigationContext.Provider>;
}

import { BranchActivity } from "./components/BranchActivity";
