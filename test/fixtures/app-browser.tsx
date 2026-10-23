import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
mockWindows('main');
mockIPC((command, args) => window.nativeCommand(command, args), { shouldMockEvents: true });
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
window.deliverNativeEvent = (event, payload) => emit(event, payload);
await import('../../clients/ui/main');
