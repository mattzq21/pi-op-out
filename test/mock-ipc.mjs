import assert from 'node:assert/strict';
import { mockIPC as mockNativeIPC, mockWindows } from '@tauri-apps/api/mocks';

export { clearMocks, mockWindows } from '@tauri-apps/api/mocks';

export function mockIPC(handler, options) {
  mockWindows('main');
  return mockNativeIPC((command, args) => {
    if (command === 'daemon_invoke') {
      assert.equal(typeof args.command, 'string');
      command = args.command;
      args = args.args;
      assert.match(args.clientId, /^desktop:.+/);
    }
    if (args && 'clientId' in args) {
      assert.match(args.clientId, /^desktop:.+/);
      const { clientId, ...commandArgs } = args;
      args = commandArgs;
    }
    return handler(command, args);
  }, options);
}
