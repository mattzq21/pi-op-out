import { locateConversation } from "./lib/conversationLookup";
import { ArchivedLinkPopup, type ArchivedLink } from "./components/ArchivedLinkPopup";
import { createDependencyEffect } from "./lib/solid";
import { ComposerPluginsContext } from "./plugins/composer";
import { TranscriptPluginsContext, conversationSource } from "./plugins/transcript";
import { createPluginWorkspace } from "./plugins/workspace";
import { AuxiliaryChatsContext, type AuxiliaryChats } from "./lib/auxiliaryChats";
import { required } from "./lib/required";
import { Rerun } from "@solid-primitives/keyed";
import { createSignal, lazy, Show } from "solid-js";
import { createAppConversations } from "./appConversations";
import { AppLoading, selectedProjectCwd } from "./appSupport";
import { createTranscriptCache } from "./components/transcriptCache";
import { useSessionMemory } from "./lib/sessionMemory";
import { FindInPage } from "./components/FindInPage";
import { debugView } from "./lib/debugFeatures";
import { SessionLinkContext, SubagentNavigationContext, type SessionLinks } from "./lib/subagentNavigation";
import { AppSidebar } from "./AppSidebar";
import { AppDialogs, AppNotices } from "./AppOverlays";
import { ChatView, ChatWorkspace } from "./ChatWorkspace";
import { BranchActivity } from "./components/BranchActivity";

export { formatCodexReset,usageWindowsDescription } from "./appSupport";

const LocalSettingsView = lazy(() => import("./components/LocalSettingsView").then(module => ({ default: module.LocalSettingsView })));

export default function App(props: { suppressConnectionNotices?: boolean } = {}) {
  const app = createAppConversations(() => { void ChatView.preload().catch(() => undefined); }, owner => transcriptCache.prepare(owner));
  const { forkSourceNameOf, chatSession, activeConversationKey, activeHostId, connected, branch, openForkSource } = app.conversation;
  const { sessions, selectSession, syncSessionIndex } = app.sessions;
  const { view, setView, panelOpen, setPanelOpen, mobileSidebarOpen, canLeaveSettings, activePane, setActivePane, hasSidePane } = app.layout;
  const { settings, setSettingsDirty, saveSettings, pendingSettingsCount } = app.settings;
  const { error, addNotice } = app.notices;
  const { sidepane, splitPane, subagentPane, splitSessionId, openSubagent } = app.side;
  const transcriptCache = createTranscriptCache(owner => {
    const session = useSessionMemory(() => owner, () => ({ model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 }));
    const hostId = owner.currentHostId();

    return () => ({ messages: session.messages, state: session.state, debug: settings() ? debugView(required(settings())) : undefined, cwd: selectedProjectCwd(owner.currentCwd(), owner.isTemporaryChat()), notify: (title, message) => addNotice({ title, message }), forkSourceName: forkSourceNameOf(session.state.forkSource, hostId), actions: { onBranch: branch, onFork: message => branch(message, "fork"), onOpenForkSource: openForkSource } });
  });


  const pluginPane = createPluginWorkspace(conversationSource(activeHostId, chatSession));

  const renderMobileSidebarBackdrop = () => (panelOpen() && view() === "chat" && <button class="mobile-sidebar-backdrop" aria-label="Close conversations" onClick={() => setPanelOpen(false)} />);

  const renderMobileSidebarToggle = () => <button type="button" class="mobile-sidebar-toggle" aria-label="Toggle conversations" aria-expanded={mobileSidebarOpen()} onClick={() => { if (canLeaveSettings()) { const open = !mobileSidebarOpen(); setView("chat"); setPanelOpen(open); } }}>☰</button>;

  const renderSettingsView = () => (view() === "settings" && <LocalSettingsView pendingSettingsCount={pendingSettingsCount()} settings={required((settings()))} sessions={sessions()} onSave={saveSettings} onDirtyChange={setSettingsDirty} onBack={() => { if (canLeaveSettings()) setView("chat"); }} />);

  const renderSubagentFind = () => subagentPane() && <FindInPage selector=".subagent-pane .chat-shell" scopeKey={`${required(subagentPane()).hostId}:${required(subagentPane()).sessionId}`} onActivate={() => setActivePane("split")} active={activePane() === "split"} enabled={view() === "chat"} />;

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
        else setArchivedLink({ hostId, sessionId, name, anchor });
      }, reason => { if (click === linkClick) addNotice({ title: "Could not open the chat", message: reason instanceof Error ? reason.message : String(reason) }); });
    },
  };
  const renderArchivedLinkPopup = () => <Show when={archivedLink()} keyed>{link => <ArchivedLinkPopup link={link} onClose={() => setArchivedLink(undefined)} onRestored={() => { setArchivedLink(undefined); setOpenWhenListed({ hostId: link.hostId, sessionId: link.sessionId }); void syncSessionIndex(); }} />}</Show>;

  return <SessionLinkContext.Provider value={sessionLinks}><AuxiliaryChatsContext.Provider value={auxiliaryChats}><SubagentNavigationContext.Provider value={openSubagent}>{!settings() ? (<AppLoading error={error()} />) : (<div role="region" aria-label={workspaceLabel()} class={`app ${panelOpen() && view() === "chat" ? "mobile-panel-open" : ""}`}>
    {!mobileSidebarOpen() && renderMobileSidebarToggle()}
    {renderMobileSidebarBackdrop()}
    <Show when={view() !== "settings"}><AppSidebar layout={app.layout} sessions={app.sessions} settings={app.settings} usage={app.usage} conversation={app.conversation} /></Show>
    <ComposerPluginsContext.Provider value={pluginPane.composers}><TranscriptPluginsContext.Provider value={pluginPane.transcripts}><transcriptCache.Host /><ChatWorkspace app={app} transcriptCache={transcriptCache} pluginPane={pluginPane} /></TranscriptPluginsContext.Provider></ComposerPluginsContext.Provider>
    {renderSettingsView()}
    <FindInPage selector=".chat-panes > .main-chat > .chat-shell" scopeKey={activeConversationKey()} onActivate={() => setActivePane("main")} active={activePane() === "main" || !hasSidePane()} enabled={view() === "chat"} />
    {renderSubagentFind()}
    {renderSplitFind()}
    {view() === "settings" && <FindInPage selector=".settings-shell" scopeKey="settings" />}
    <AppNotices notices={app.notices} transport={app.conversation.transport} suppressConnectionNotices={props.suppressConnectionNotices} />
    {renderArchivedLinkPopup()}
    <BranchActivity />
    <AppDialogs dialogs={app.dialogs} conversation={app.conversation} syncSessionIndex={syncSessionIndex} />
  </div>)}</SubagentNavigationContext.Provider></AuxiliaryChatsContext.Provider></SessionLinkContext.Provider>;
}


