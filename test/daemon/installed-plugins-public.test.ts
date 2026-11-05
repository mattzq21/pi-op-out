import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { save } from '../../daemon/resources/session-database/records.ts';
import { agentDaemon } from './agent-chats';
import { temporaryDirectory } from './harness';

// A plugin that the user installs: a folder with its manifest, its Pi extension and its client part, all built.
const MANIFEST = {
  id: 'hello', name: 'Hello', extension: { after: 'session' }, commands: { hello: 'immediate' }, settings: { greeting: 'Hello' }, stateRecords: ['hello-last'],
  messages: { 'hello-note': { customRole: 'system', contextInjection: false } }, auxiliary: { label: 'Hello chats', letter: 'H', color: '#336699' },
  client: { scope: 'host' },
};
const EXTENSION = `export default function hello(pi) {
  pi.registerCommand("hello", { description: "Say hello", handler: async (args, ctx) => {
    const seen = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "hello-last").map(entry => entry.data.to);
    pi.appendEntry("hello-last", { to: args });
    pi.sendMessage({ customType: "hello-note", content: "Hello " + args, display: true, details: { to: args, seen } }, { triggerTurn: false });
  } });
}
`;
// Two plugins that note when Pi loads them; the first tells the order.
const LOADED = (id: string) => `globalThis.piopLoaded = [...(globalThis.piopLoaded ?? []), "${id}"];
export default function plugin(pi) {
  ${id === 'order-a' ? 'pi.registerCommand("order", { description: "Load order", handler: async () => { pi.sendMessage({ customType: "order-note", content: globalThis.piopLoaded.join(","), display: true }, { triggerTurn: false }); } });' : ''}
}
`;
const CLIENT = `const { createComponent } = globalThis[Symbol.for("piop.plugin-modules")]["solid-js"];
export const messages = { "hello-note": () => "A hello" };
`;

let agents: Awaited<ReturnType<typeof agentDaemon>>;
let plugins: string;

beforeAll(async () => {
  const home = temporaryDirectory('piop-home-');
  plugins = join(home, '.piop', 'plugins');
  mkdirSync(join(plugins, 'hello'), { recursive: true });
  writeFileSync(join(plugins, 'hello', 'plugin.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(plugins, 'hello', 'extension.mjs'), EXTENSION);
  writeFileSync(join(plugins, 'hello', 'client.mjs'), CLIENT);
  mkdirSync(join(plugins, 'empty'));
  for (const id of ['order-a', 'order-b']) {
    mkdirSync(join(plugins, id));
    writeFileSync(join(plugins, id, 'plugin.json'), JSON.stringify({ id, name: id, extension: { after: 'session' }, ...id === 'order-a' ? { commands: { order: 'immediate' } } : {} }));
    writeFileSync(join(plugins, id, 'extension.mjs'), LOADED(id));
  }
  // The user chose to load order-b before order-a.
  save(join(home, '.piop'), 'plugins', JSON.stringify({ enabled: ['hello', 'order-b', 'order-a'], previous: [], known: ['hello', 'order-a', 'order-b'] }));
  agents = await agentDaemon({ home });
}, 60_000);
afterAll(async () => { await agents?.close(); });

test('a plugin in the plugin folder loads when the daemon starts, and a folder that is not a plugin is reported', async () => {
  const status = await agents.daemon.invoke('plugin_status', { hostId: 'local' });
  expect(status.plugins).toContainEqual({ id: 'hello', name: 'Hello', messages: MANIFEST.messages, auxiliary: MANIFEST.auxiliary, client: { scope: 'host' } });
  expect(status.enabled).toContain('hello');
  expect(status.error).toBe(`The plugin in ${join(plugins, 'empty')} could not load: plugin.json is missing`);
  expect(await agents.daemon.invoke('plugin_client', { hostId: 'local', id: 'hello' })).toEqual({ source: CLIENT });
  expect(await agents.daemon.failure('plugin_client', { hostId: 'local', id: 'btw' })).toBe('The plugin btw has no client part');
  expect((await agents.daemon.invoke('load_app_settings', { hostId: 'local' })).plugins.hello).toEqual({ greeting: 'Hello' });
}, 60_000);

test('the command of an installed plugin runs in a chat, and clients get its message with how to show it', async () => {
  const chat = await agents.rootChat();
  const shown = agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'message_end' && payload.event.message?.customType === 'hello-note', 30_000);
  await chat.command({ type: 'prompt', message: '/hello world' });
  expect((await shown).event.message).toMatchObject({ role: 'custom', content: 'Hello world', pluginMessage: MANIFEST.messages['hello-note'] });
  const entries = (await chat.command({ type: 'get_entries' })).entries;
  expect(entries.find((entry: any) => entry.customType === 'hello-note')).toMatchObject({
    type: 'custom_message', content: 'Hello world', details: { to: 'world', seen: [] }, pluginMessage: MANIFEST.messages['hello-note'],
  });
}, 60_000);

test('a state record of an installed plugin keeps only its last value', async () => {
  const chat = await agents.rootChat();
  const seen: string[][] = [];
  for (const name of ['first', 'second', 'third']) {
    const shown = agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'message_end' && payload.event.message?.content === 'Hello ' + name, 30_000);
    await chat.command({ type: 'prompt', message: '/hello ' + name });
    seen.push((await shown).event.message.details.seen);
  }
  expect(seen).toEqual([[], ['first'], ['second']]);
}, 60_000);

test('Pi loads the enabled plugins in the order that the user chose', async () => {
  expect((await agents.daemon.invoke('plugin_status', { hostId: 'local' })).enabled.slice(0, 3)).toEqual(['hello', 'order-b', 'order-a']);
  const chat = await agents.rootChat();
  const shown = agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'message_end' && payload.event.message?.customType === 'order-note', 30_000);
  await chat.command({ type: 'prompt', message: '/order' });
  expect((await shown).event.message.content).toBe('order-b,order-a');
}, 60_000);
