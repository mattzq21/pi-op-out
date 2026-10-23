import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import '../../clients/ui/styles.css';
import '../../clients/ui/mobile.css';

mockWindows('main');
mockIPC((command, args) => window.nativeCommand(command, args), { shouldMockEvents: true });
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
const { Composer } = await import('../../clients/ui/components/Composer');
const [focusRequest, setFocusRequest] = createSignal(0);
const [sendMode, setSendMode] = createSignal("accept");
const [pendingSend, setPendingSend] = createSignal<{ resolve: () => void; reject: (error: Error) => void }>();
const [sent, setSent] = createSignal<unknown[]>([]);
const [choices, setChoices] = createSignal<unknown[]>([]);
const [disabled, setDisabled] = createSignal(false);
const [agentUnavailable, setAgentUnavailable] = createSignal(false);
const [streaming, setStreaming] = createSignal(false);
const [modelsAvailable, setModelsAvailable] = createSignal(true);
const [fastModeStatus, setFastModeStatus] = createSignal<string>();
const [fastRequests, setFastRequests] = createSignal(0);
const [rejectFast, setRejectFast] = createSignal<((error: Error) => void)>();
const [paused, setPaused] = createSignal(false);
const [actions, setActions] = createSignal<string[]>([]);
const [rejectPause, setRejectPause] = createSignal<((error: Error) => void)>();
const [completeResume, setCompleteResume] = createSignal<(() => void)>();
const choose = (value: unknown) => setChoices(values => [...values, value]);

render(() => <>
  <button onClick={() => setFocusRequest(value => value + 1)}>Focus message editor</button>
  <label><input type="checkbox" checked={disabled()} onChange={event => setDisabled(event.currentTarget.checked)} />Disable controls</label>
  <label><input type="checkbox" checked={agentUnavailable()} onChange={event => setAgentUnavailable(event.currentTarget.checked)} />Agent unavailable</label>
  <label><input type="checkbox" checked={modelsAvailable()} onChange={event => setModelsAvailable(event.currentTarget.checked)} />Models available</label>
  <label><input type="checkbox" checked={streaming()} onChange={event => setStreaming(event.currentTarget.checked)} />Streaming response</label>
  <label>Send result<select value={sendMode()} onChange={event => setSendMode(event.currentTarget.value)}><option value="accept">Accept</option><option value="hold">Hold</option><option value="refuse">Refuse</option></select></label>
  <button disabled={!pendingSend()} onClick={() => pendingSend()?.reject(new Error("connection lost"))}>Reject send</button>
  <button disabled={!pendingSend()} onClick={() => pendingSend()?.resolve()}>Complete send</button>
  <button onClick={() => setFastModeStatus('Fast mode off')}>Enable Fast mode control</button>
  <button disabled={!rejectFast()} onClick={() => rejectFast()?.(new Error('offline'))}>Reject Fast mode request</button>
  <button onClick={() => setFastModeStatus('Fast mode on')}>Report Fast mode on</button>
  <output aria-label="Fast mode requests">{fastRequests()}</output>
  <button disabled={!rejectPause()} onClick={() => rejectPause()?.(new Error('cannot pause'))}>Reject pause request</button>
  <button onClick={() => { setStreaming(false); setPaused(true); }}>Report paused</button>
  <button disabled={!completeResume()} onClick={() => completeResume()?.()}>Complete resume request</button>
  <output aria-label="Control requests">{JSON.stringify(actions())}</output>
  <output aria-label="Sent messages">{JSON.stringify(sent())}</output>
  <output aria-label="Selected values">{JSON.stringify(choices())}</output>
  <div style={{ width: '600px', margin: '80px 150px' }}>
    <Composer paused={paused()} streaming={streaming()} queued={streaming() ? 2 : 0} pendingMessages={streaming() ? [{ id: "steer", message: "Steer", behavior: "steer" }, { id: "later", message: "Later", behavior: "followUp" }] : []} onChangePending={async () => {}} commands={[{ name: "clear", source: "extension", description: "Clear context" }, { name: "compact", source: "extension" }, { name: "skill:Research", source: "skill" }, { name: "rs", source: "extension", options: [{ value: "", label: "[n] [scope]", description: "Number of review subagents" }] }, { name: "fast", source: "extension", options: [{ value: "on", label: "on" }, { value: "off", label: "off" }, { value: "toggle", label: "toggle" }] }]} agents={[{ name: "default", tools: [] }, { name: "review", tools: [] }]} models={modelsAvailable() ? [{ provider: "provider", id: "gpt-small", name: "gpt-Small" }] : []} model={null} controlsDisabled={disabled()}
      focusRequest={focusRequest()} thinkingLevel="off" thinkingLevels={['off', 'high']} agentUnavailable={agentUnavailable()} agentLocked={agentUnavailable()} activeAgent="default"
      onSend={async (message, behavior, images) => { setSent(values => [...values, [message, behavior, images]]);
        if (sendMode() === "refuse") return false;
        if (sendMode() === "hold") { try { await new Promise<void>((resolve, reject) => setPendingSend({ resolve, reject })); } finally { setPendingSend(undefined); } }
      }} onPause={async () => {
        setActions(values => [...values, 'pause']);
        try { await new Promise<void>((_, reject) => setRejectPause(() => reject)); }
        finally { setRejectPause(undefined); }
      }} onResume={async () => {
        setActions(values => [...values, 'resume']);
        try { await new Promise<void>(resolve => setCompleteResume(() => resolve)); }
        finally { setCompleteResume(undefined); }
      }} onAbort={async () => { setActions(values => [...values, 'stop']); throw 'cannot stop'; }}
      onAgent={choose} onModel={choose} onThinking={choose} fastModeStatus={fastModeStatus()} onToggleFastMode={async () => {
        setFastRequests(value => value + 1);
        if (fastModeStatus() === 'Fast mode off') {
          try { await new Promise<void>((_, reject) => setRejectFast(() => reject)); }
          finally { setRejectFast(undefined); }
        }
      }} />
  </div>
</>, document.getElementById('root')!);
