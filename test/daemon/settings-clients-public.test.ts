import { expect, test } from 'bun:test';
import { startDaemon, synchronizationFinished, temporaryDirectory, type TestDaemon } from './harness';

test('separate development daemons notify their clients when shared settings change', async () => {
  const home = temporaryDirectory('piop-settings-shared-');
  const running: TestDaemon[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const daemon = await startDaemon({ home, development: true, projectRoot: temporaryDirectory('piop-settings-project-') });
      running.push(daemon);
      const initial = await daemon.invoke('load_app_settings');
      initial.reviewPrompt = 'Initial settings for project ' + index;
      const baseline = await daemon.invoke('save_app_settings', { settings: initial });
      await synchronizationFinished(daemon, baseline.revision);
    }
    const [first, second] = running as [TestDaemon, TestDaemon];
    const settings = await first.invoke('load_app_settings');
    settings.reviewPrompt = 'Review changes from the first project';
    const saved = await first.invoke('save_app_settings', { settings });
    const received = await second.waitEvent('pi://settings-changed', change =>
      change.settings.reviewPrompt === 'Review changes from the first project');
    expect(received.revision).toBe(saved.committedRevision);

    const next = await second.invoke('save_app_settings', {
      settings: { ...received.settings, reviewPrompt: 'Review changes from the second project' },
    });
    const returned = await first.waitEvent('pi://settings-changed', change =>
      change.settings.reviewPrompt === 'Review changes from the second project');
    expect(returned.revision).toBe(next.committedRevision);
    expect((await first.invoke('load_app_settings')).reviewPrompt)
      .toBe('Review changes from the second project');
  } finally { await Promise.all(running.map(daemon => daemon.stop())); }
}, 60_000);

test('saved settings survive a daemon restart and the saved version remains editable', async () => {
  let daemon = await startDaemon();
  try {
    const settings = await daemon.invoke('load_app_settings');
    settings.reviewPrompt = 'Check that user data survives failures';
    const saved = await daemon.invoke('save_app_settings', { settings });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });

    const restored = await daemon.invoke('load_settings_change');
    expect(restored.settings.reviewPrompt).toBe('Check that user data survives failures');
    expect(restored.revision).toBe(saved.committedRevision);
    expect(restored.settings.settingsRevision).toBe(saved.settings.settingsRevision);
    const next = await daemon.invoke('save_app_settings', {
      settings: { ...saved.settings, reviewPrompt: 'Check recovery after a second save' },
    });
    expect(next.committedRevision).toBe(saved.committedRevision + 1);
    expect((await daemon.invoke('load_app_settings')).reviewPrompt)
      .toBe('Check recovery after a second save');
  } finally { await daemon.stop(); }
}, 60_000);

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
