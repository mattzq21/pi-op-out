import assert from 'node:assert/strict';
import { mockIPC as mockNativeIPC, mockWindows } from '@tauri-apps/api/mocks';

export { clearMocks, mockWindows } from '@tauri-apps/api/mocks';

function desktopBackground() {
  return {};
}

export function mockIPC(handler, options = {}) {
  mockWindows('main');
  const background = options.background === false ? {} : desktopBackground();

  mockNativeIPC((command, args) => {
    if (command === 'daemon_invoke') {
      assert.match(args.command, /^[a-z][a-z0-9_]*$/);
      command = args.command;
      args = args.args;
      assert.match(args.clientId, /^desktop:.+/);
    }

    if (args && 'clientId' in args) {
      assert.match(args.clientId, /^desktop:.+/);
      const { clientId, ...commandArgs } = args;
      args = commandArgs;
    }

    if (Object.hasOwn(background, command)) return background[command](args);

    return handler(command, args);
  }, options);
  if (options.shouldMockEvents) {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args, invokeOptions) => invoke(command,
      command === 'plugin:event|unlisten' ? { event: args.event, id: args.eventId } : args, invokeOptions);
  }
}
