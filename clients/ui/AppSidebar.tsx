import { Archive, Bug, FolderPlus, MessageSquare, Server, Settings } from "lucide-solid";
import { Show } from "solid-js";
import type { AppConversations } from "./appConversations";
import { LimitBadge, OpencodexBadges, UsageError } from "./appSupport";
import { ArchivedSessionPanel } from "./components/ArchivedSessionPanel";
import { DebugModeButton } from "./components/DebugModeButton";
import { IconButton } from "./components/IconButton";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { SessionPanel } from "./components/SessionPanel";
import { debugView } from "./lib/debugFeatures";
import { isMobile } from "./lib/platform";
import { required } from "./lib/required";
import { preloadSettingsResources } from "./lib/settingsResources";

// The left rail: navigation buttons, the conversation list and the usage badges.
export function AppSidebar(props: { layout: AppConversations["layout"]; sessions: AppConversations["sessions"]; settings: AppConversations["settings"]; usage: AppConversations["usage"]; conversation: Pick<AppConversations["conversation"], "transport" | "activeConversationKey" | "activeHostId"> }) {
  const { view, setView, panelOpen, setPanelOpen, canLeaveSettings } = props.layout;
  const { sidebar, listedRunningSessions, unseenSessions, selectSession, sessionAction, startNewSession, newSession, newChatRequest, createGroupRequest, setCreateGroupRequest, handleCreateGroup, isArchiving, query, setQuery, archivesOpen, setArchivesOpen } = props.sessions;
  const { settings, settingsSaving, debugModeSaving, toggleDebugMode, toggleDebugFeature } = props.settings;
  const { codexUsage, anthropicUsage, usageClock, opencodeGoBadge, opencodexUsage, usageError, refreshUsage, refreshingUsage } = props.usage;
  const { transport, activeConversationKey, activeHostId } = props.conversation;

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

  return renderSidebar();
}
