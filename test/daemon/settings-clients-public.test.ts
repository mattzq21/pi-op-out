import { expect, test } from 'bun:test';
import { startDaemon } from './harness';

test('simultaneous settings saves accept one client and let the other retry after reloading', async () => {
  const daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const clients = [daemon, other];
    const settings = await Promise.all(clients.map(client => client.invoke('load_app_settings')));
    settings[0].reviewPrompt = 'Review correctness';
    settings[1].reviewPrompt = 'Review reliability';
    const results = await Promise.allSettled(clients.map((client, index) =>
      client.invoke('save_app_settings', { settings: settings[index] })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.findIndex(result => result.status === 'rejected');
    const failure = results[rejected] as PromiseRejectedResult;
    expect(failure.reason.message).toContain('Settings changed in another window or client');
    const saved = await clients[rejected]!.invoke('load_app_settings');
    expect(saved.reviewPrompt).toBe(settings[1 - rejected].reviewPrompt);

    saved.reviewPrompt = 'Review correctness and reliability';
    await clients[rejected]!.invoke('save_app_settings', { settings: saved });
    expect((await clients[1 - rejected]!.invoke('load_app_settings')).reviewPrompt)
      .toBe('Review correctness and reliability');
  } finally { await daemon.stop(); }
}, 60_000);

test('another connected client receives saved settings and can edit that received version', async () => {
  const daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const settings = await daemon.invoke('load_app_settings');
    settings.reviewPrompt = 'Check failure recovery';
    const saved = await daemon.invoke('save_app_settings', { settings });
    const received = await other.waitEvent('pi://settings-changed', change =>
      change.settings.reviewPrompt === 'Check failure recovery');
    expect(received.settings).toEqual(saved.settings);
    expect(received.revision).toBe(saved.revision);

    const edited = { ...received.settings, reviewPrompt: 'Check recovery and data preservation' };
    await other.invoke('save_app_settings', { settings: edited });
    const returned = await daemon.waitEvent('pi://settings-changed', change =>
      change.settings.reviewPrompt === 'Check recovery and data preservation');
    expect(returned.settings.reviewPrompt).toBe('Check recovery and data preservation');
    expect((await daemon.invoke('load_app_settings')).reviewPrompt)
      .toBe('Check recovery and data preservation');
  } finally { await daemon.stop(); }
}, 60_000);
