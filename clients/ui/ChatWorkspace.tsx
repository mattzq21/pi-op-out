import { Rerun } from "@solid-primitives/keyed";
import { PanelRight } from "lucide-solid";
import { createComponent, createMemo, lazy, onCleanup, Show } from "solid-js";
import type { AppConversations } from "./appConversations";
import { splitConversationKey } from "./appSupport";
import { AgentsPill } from "./components/AuxiliaryAgents";
import { DraftRecovery } from "./components/DraftRecovery";
import { IconButton } from "./components/IconButton";
import { SidepaneTabs } from "./components/SidepaneTabs";
import type { TranscriptCache } from "./components/transcriptCache";
import { debugView } from "./lib/debugFeatures";
import { hostChoices } from "./lib/hostChoices";
import { localHostLabel } from "./lib/mobileHosts";
import { required } from "./lib/required";
import type { SidepaneTab } from "./lib/sidepaneTabs";
import { sameFacts, subagentFacts } from "./lib/subagentFacts";
import { Sidepane } from "./plugins/Sidepane";
import type { PluginWorkspace } from "./plugins/workspace";

const TerminalView = lazy(() => import("./components/TerminalView").then(module => ({ default: module.TerminalView })));

function preloadSettings() {
  let disposed = false;
  const timer = setTimeout(() => {
    if (!disposed) void import("./components/LocalSettingsView").catch(reason => console.error("Could not preload the settings page:", reason));
  }, 1000);
  onCleanup(() => { disposed = true; clearTimeout(timer); });
}

export const ChatView = lazy(() => import("./components/ChatView").then(module => ({ default: (props: Parameters<typeof module.ChatView>[0]) => {
  preloadSettings();
  return createComponent(module.ChatView, props);
} })));

const SplitChatPane = lazy(() => import("./components/SplitChatPane").then(module => ({ default: module.SplitChatPane })));

const SubagentPane = lazy(() => import("./components/SubagentPane").then(module => ({ default: module.SubagentPane })));

// The chat area: the main conversation, the side pane with side chats and subagents, and the terminal panel.
export function ChatWorkspace(props: { app: Omit<AppConversations, "usage">; transcriptCache: TranscriptCache; pluginPane: PluginWorkspace }) {
  const { transcriptCache, pluginPane } = props;
  const { transport, runtimePool, chatSession, chatViewKey, activeConversationKey, activeHostId, connected, composerView, composerState, composerControls, chatCommands, chatWidgets, statuses, projectCwd, send, abortInteraction, setModel, setThinking, setAgent, branch, forkSourceName, forkPoints, openForkSource, revealEntryId, entryRevealed, draftChangeFor, uploadsChangeFor, drafts, uploadsByTransport, setComposerUploads, mainComposerFocusRequest, mainQueueHoldRequest, chooseChatHost, chooseChatProject, clearChatProject, modelVisibility } = props.app.conversation;
  const { sessions, archiveSession, isArchiving, setArchivesOpen, selectSession } = props.app.sessions;
  const { view, setPanelOpen, setActivePane } = props.app.layout;
  const { settings } = props.app.settings;
  const { addNotice } = props.app.notices;
  const { queueExtensionDialog, resolveExtensionDialog, closeTransportDialogs } = props.app.dialogs;
  const { sidepane, splitPane, subagentPane, respondToSplitRequest, closeSplitPane, releaseSplitTransport, splitComposerFocusRequest, splitQueueHoldRequest } = props.app.side;
  const { terminals, terminalOpen, terminalLocationState, startTerminal, addTerminal, selectTerminal, deleteTerminal, terminalViewKey, toggleComposerTerminal } = props.app.terminal;

  const closeTab = async (tab: SidepaneTab) => {
    if (tab.kind === "subagent") { sidepane.forget(tab.key); return; }

    if (sidepane.workingTree(tab.session) && !window.confirm(`“${tab.label}” or one of its subagents is working. Stop them and archive it?`)) return;
    await archiveSession(tab.session);
  };

  const sideVisible = () => sidepane.open() && (sidepane.tabs().length > 0 || Boolean(pluginPane.error()));
  const sidepaneButton = () => <Show when={sidepane.tabs().length || pluginPane.error()}><IconButton class="open-plugins-button" label={sidepane.working() ? "Open side pane, a side chat is working" : "Open side pane"} aria-controls="plugin-sidepane" aria-expanded={sideVisible()} onClick={() => { if (sideVisible()) closeSplitPane(); else { sidepane.setOpen(true); setActivePane("split"); } }}><PanelRight size={19} /><Show when={sidepane.working()}><span class="sidepane-dot" /></Show></IconButton></Show>;

  const subagents = createMemo(() => subagentFacts(chatSession().messages, activeHostId()), undefined, { equals: sameFacts });
  const agentsIndicator = () => <AgentsPill agents={sidepane.agents()} subagents={subagents} onOpen={agent => { sidepane.openAuxiliary(agent.session); setActivePane("split"); }} />;

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

  return renderChatWorkspace();
}
