import { render } from 'solid-js/web';
import { SessionPanel } from '../../clients/ui/components/SessionPanel';
import { createSidebarState } from '../../clients/ui/lib/sidebarState';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

mockWindows('main');
mockIPC((command, args) => {
  if (command === 'daemon_invoke') return window.daemonInvoke(args.command, args.args);
  return window.daemonInvoke(command, args);
}, { shouldMockEvents: true });
const sdkInvoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) => sdkInvoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);

function Sidebar() {
  const sessions = window.fixtureSessions;
  const sidebar = createSidebarState(() => sessions, () => '');
  return <SessionPanel sessions={sessions} sidebar={sidebar} query="" isArchiving={() => false}
    onQuery={() => {}} onSelect={() => {}} onAction={() => {}} onNewChat={() => {}} />;
}
render(() => <Sidebar />, document.getElementById('app')!);
