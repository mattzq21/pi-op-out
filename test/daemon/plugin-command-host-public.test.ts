import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { read, write } from '../../daemon/src/restart_storage';
import { remoteMachine, startDaemon, useRemotes } from './harness';

test('new chat commands use the selected host plugin setup', async () => {
  const daemon = await startDaemon();
  const remote = await remoteMachine(daemon, 'plugin-host', 'Plugin host');
  try {
    write(join(remote.home, '.piop', 'plugins.json'), { enabled: ['cost'], previous: [], known: ['cost', 'review', 'web-search', 'btw'] });
    await useRemotes(daemon, [remote]);
    expect(await daemon.invoke('plugin_status', { hostId: remote.id })).toMatchObject({ enabled: ['cost'], error: null });
    const commands = async (hostId: string) => (await daemon.invoke('provider_auth', { hostId, request: { action: 'draft_catalog', reload: true } })).commands.filter((name: string) => ['cost', 'review', 'rs'].includes(name));
    expect(await commands(remote.id)).toEqual(['cost']);
    expect(await commands('local')).toEqual(['cost', 'review', 'rs']);
  } finally { await remote.stop(); await daemon.stop(); }
}, 180000);

test('a bundled plugin that a host has not offered yet turns on once, and the other choices stay', async () => {
  const daemon = await startDaemon();
  const remote = await remoteMachine(daemon, 'plugin-upgrade', 'Upgraded host');
  try {
    const file = join(remote.home, '.piop', 'plugins.json');
    // A setup saved before web-search existed, by a daemon that kept no known list.
    write(file, { enabled: ['cost'], previous: [] });
    await useRemotes(daemon, [remote]);
    expect(await daemon.invoke('plugin_status', { hostId: remote.id })).toMatchObject({ enabled: ['cost', 'web-search', 'btw'], error: null });
    expect(read(file)).toEqual({ enabled: ['cost', 'web-search', 'btw'], previous: [], known: ['cost', 'review', 'web-search', 'btw'] });
  } finally { await remote.stop(); await daemon.stop(); }
}, 180000);
