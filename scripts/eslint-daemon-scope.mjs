import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tsParser from '@typescript-eslint/parser';

const root = new URL('../', import.meta.url);
const fragments = [
  'src-tauri/resources/daemon-queue.mjs',
  'extensions/piop-runtime-settings/provider-accounts.mjs',
  'src-tauri/resources/provider-auth.mjs',
  'src-tauri/resources/conversation-ownership.mjs',
  'src-tauri/resources/voice-service.mjs',
  'src-tauri/resources/host-daemon-commands.mjs',
  'src-tauri/resources/host-daemon.mjs',
];

// daemon.rs concatenates these fragments into one module before starting Node.
const references = fragments.map((file) => {
  const path = fileURLToPath(new URL(file, root));
  const { scopeManager } = tsParser.parseForESLint(readFileSync(path, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest' });
  return { path, names: new Set(scopeManager.globalScope.through.filter((reference) => reference.isRead()).map((reference) => reference.identifier.name)) };
});

export default {
  files: fragments,
  plugins: {
    'daemon-scope': {
      rules: {
        'shared-bindings': {
          meta: { schema: [] },
          create(context) {
            return {
              Program() {
                for (const fragment of references) {
                  if (fragment.path === context.filename) continue;
                  for (const name of fragment.names) context.sourceCode.markVariableAsUsed(name);
                }
              },
            };
          },
        },
      },
    },
  },
  rules: { 'daemon-scope/shared-bindings': 'error' },
};
