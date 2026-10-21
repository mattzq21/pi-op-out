import assert from 'node:assert/strict';
import { mockIPC as mockNativeIPC, mockWindows } from '@tauri-apps/api/mocks';

export { clearMocks, mockWindows } from '@tauri-apps/api/mocks';

/**
 * Desktop services that every composer starts in the background: prompt history sync and the dictation status.
 * They answer like an idle desktop, so tests only see the commands they exercise. Pass `{ background: false }` to handle them yourself.
 */
function desktopBackground() {
  const history = [];

  return {
    sync_prompt_history: ({ entries, legacy }) => { history.push(...legacy, ...entries.map(entry => entry.prompt)); history.splice(0, Math.max(0, history.length - 100));

    return [...history]; },
    'plugin:dictation|dictation_configuration': () => ({ enabled: false, loading: false }),
  };
}

export function mockIPC(handler, options = {}) {
  mockWindows('main');
  const background = options.background === false ? {} : desktopBackground();

  return mockNativeIPC((command, args) => {
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
}
