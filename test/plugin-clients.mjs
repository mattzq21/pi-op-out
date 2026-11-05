import { readFileSync } from 'node:fs';
import { pluginClientSource } from '../scripts/daemon-imports.mjs';

const manifest = id => JSON.parse(readFileSync(new URL(`../plugins/${id}/plugin.json`, import.meta.url), 'utf8'));

// The summaries of the built-in plugins that a daemon gives in its plugin status.
export const CATALOG = ['cost', 'review', 'web-search'].map(id => {
  const { name, messages, auxiliary, client } = manifest(id);
  return { id, name, ...messages ? { messages } : {}, ...auxiliary ? { auxiliary } : {}, ...client ? { client } : {} };
});

// Built before the tests, so that a test does not wait for the build.
const sources = new Map(await Promise.all(CATALOG.filter(plugin => plugin.client).map(async plugin => [plugin.id, { source: await pluginClientSource(plugin.id) }])));

// Answers plugin_client as a daemon does, with the built client part of the plugin.
export function pluginClient(args) {
  if (!sources.has(args.id)) throw new Error('The plugin ' + args.id + ' has no client part');
  return sources.get(args.id);
}
