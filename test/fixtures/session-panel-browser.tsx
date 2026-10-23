import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import '../../clients/ui/styles.css';

globalThis.isTauri = true;
mockWindows('main');
mockIPC((command, args) => window.panelCommand(command, args), { shouldMockEvents: true });
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
window.deliverPanelEvent = (event, payload) => emit(event, payload);
const { SessionPanel } = await import('../../clients/ui/components/SessionPanel');
const { createSidebarState } = await import('../../clients/ui/lib/sidebarState');
const { NativeTransport } = await import('../../clients/ui/lib/nativeTransport');
const { invoke: daemonInvoke } = await import('../../clients/ui/lib/platform');
// The panel gets the same transport and settings as in the app, so project pickers can browse the daemon's folders.
const transport = new NativeTransport({ hostId: 'local' });
const settings = await daemonInvoke('load_app_settings');
const [sessions, setSessions] = createSignal(await window.panelSessions());
window.refreshPanelSessions = async () => setSessions(await window.panelSessions());
const activeId = await window.panelActiveId();
const [query, setQuery] = createSignal('');
const [selected, setSelected] = createSignal<string[]>([]);

const [actions, setActions] = createSignal<unknown[]>([]);

const [groupRequest, setGroupRequest] = createSignal(0);
const [handledGroups, setHandledGroups] = createSignal(0);

function Panel() {
  const sidebar = createSidebarState(sessions, query);
  return <SessionPanel transport={transport} settings={settings as any} activeId={activeId} createGroupRequest={groupRequest()} onCreateGroupHandled={() => setHandledGroups(value => value + 1)} sidebar={sidebar} query={query()} isArchiving={() => false} onQuery={setQuery}
    onSelect={session => { setSelected(values => [...values, session.id]); return undefined; }}
    onAction={(session, action) => setActions(values => [...values, [session, action]])} onNewChat={() => {}} />;
}
render(() => <>
  <button onClick={() => window.refreshPanelSessions()}>Refresh conversation list</button>
  <button onClick={() => setGroupRequest(value => value + 1)}>Request new group</button>
  <output aria-label="Handled group requests">{handledGroups()}</output>
  <output aria-label="Selected conversations">{JSON.stringify(selected())}</output>
  <output aria-label="Conversation actions">{JSON.stringify(actions())}</output>
  <aside class="sidebar" style={{ width: '320px', height: '500px', margin: '60px', display: 'flex', 'flex-direction': 'column' }}><Panel /></aside>
</>, document.getElementById('root')!);
