import { expect, test } from 'bun:test';
import { startDaemon, synchronizationFinished, temporaryDirectory, type TestDaemon } from './harness';

test.concurrent('development daemons of two checkouts keep separate settings', async () => {
  const home = temporaryDirectory('piop-settings-separate-');
  const running: TestDaemon[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      running.push(await startDaemon({ home, development: true, projectRoot: temporaryDirectory('piop-settings-project-') }));
    }
    const [first, second] = running as [TestDaemon, TestDaemon];
    const untouched = await second.invoke('load_app_settings');
    const settings = await first.invoke('load_app_settings');
    settings.plugins.review.reviewAgent = 'Review changes from the first checkout';
    const saved = await first.invoke('save_app_settings', { settings });
    await synchronizationFinished(first, saved.committedRevision);
    expect((await first.invoke('load_app_settings')).plugins.review.reviewAgent).toBe('Review changes from the first checkout');
    expect((await second.invoke('load_app_settings')).plugins.review.reviewAgent).toBe(untouched.plugins.review.reviewAgent);
    expect(second.events.filter(event => event.event === 'pi://settings-changed' && event.payload.settings?.plugins.review.reviewAgent === 'Review changes from the first checkout')).toEqual([]);
  } finally { await Promise.all(running.map(daemon => daemon.stop())); }
}, 60_000);

test.concurrent('saved settings survive a daemon restart and the saved version remains editable', async () => {
  let daemon = await startDaemon();
  try {
    const settings = await daemon.invoke('load_app_settings');
    settings.plugins.review.reviewAgent = 'Check that user data survives failures';
    const saved = await daemon.invoke('save_app_settings', { settings });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });

    const restored = await daemon.invoke('load_settings_change');
    expect(restored.settings.plugins.review.reviewAgent).toBe('Check that user data survives failures');
    expect(restored.revision).toBe(saved.committedRevision);
    expect(restored.settings.settingsRevision).toBe(saved.settings.settingsRevision);
    const next = await daemon.invoke('save_app_settings', {
      settings: { ...saved.settings, plugins: { ...saved.settings.plugins, review: { reviewAgent: 'Check recovery after a second save' } } },
    });
    expect(next.committedRevision).toBe(saved.committedRevision + 1);
    expect((await daemon.invoke('load_app_settings')).plugins.review.reviewAgent)
      .toBe('Check recovery after a second save');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('simultaneous settings saves accept one client and let the other retry after reloading', async () => {
  const daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const clients = [daemon, other];
    const settings = await Promise.all(clients.map(client => client.invoke('load_app_settings')));
    settings[0].plugins.review.reviewAgent = 'Review correctness';
    settings[1].plugins.review.reviewAgent = 'Review reliability';
    const results = await Promise.allSettled(clients.map((client, index) =>
      client.invoke('save_app_settings', { settings: settings[index] })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.findIndex(result => result.status === 'rejected');
    const failure = results[rejected] as PromiseRejectedResult;
    expect(failure.reason.message).toContain('Settings changed in another window or client');
    const saved = await clients[rejected]!.invoke('load_app_settings');
    expect(saved.plugins.review.reviewAgent).toBe(settings[1 - rejected].plugins.review.reviewAgent);

    saved.plugins.review.reviewAgent = 'Review correctness and reliability';
    await clients[rejected]!.invoke('save_app_settings', { settings: saved });
    expect((await clients[1 - rejected]!.invoke('load_app_settings')).plugins.review.reviewAgent)
      .toBe('Review correctness and reliability');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('another connected client receives saved settings and can edit that received version', async () => {
  const daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const settings = await daemon.invoke('load_app_settings');
    settings.plugins.review.reviewAgent = 'Check failure recovery';
    const saved = await daemon.invoke('save_app_settings', { settings });
    const received = await other.waitEvent('pi://settings-changed', change =>
      change.settings.plugins.review.reviewAgent === 'Check failure recovery');
    expect(received.settings).toEqual(saved.settings);
    expect(received.revision).toBe(saved.revision);

    const edited = { ...received.settings, plugins: { ...received.settings.plugins, review: { reviewAgent: 'Check recovery and data preservation' } } };
    await other.invoke('save_app_settings', { settings: edited });
    const returned = await daemon.waitEvent('pi://settings-changed', change =>
      change.settings.plugins.review.reviewAgent === 'Check recovery and data preservation');
    expect(returned.settings.plugins.review.reviewAgent).toBe('Check recovery and data preservation');
    expect((await daemon.invoke('load_app_settings')).plugins.review.reviewAgent)
      .toBe('Check recovery and data preservation');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('a save that edits one setting keeps every other saved setting across a daemon restart', async () => {
  let daemon = await startDaemon();
  try {
    const settings = await daemon.invoke('load_app_settings');
    Object.assign(settings, {
      plugins: { review: { reviewAgent: 'reviewer' }, 'web-search': { webSearchModel: 'anthropic/claude' } }, localEnabled: false, defaultThinking: 'high', defaultFastMode: true,
      modelAliases: { 'openai/gpt': 'Daily model' }, hiddenModels: ['openai/old'],
      contextWindowCap: 200_000, contextWindowCapEnabled: false,
      modelContextWindowCaps: { 'openai/gpt': 400_000, 'anthropic/claude': null },
      autoRetry: false, debugMode: true,
      hosts: [{ enabled: false, id: 'build', name: 'Build server', target: 'user@build', piPath: '~/bin/pi' }],
    });
    settings.keybindings.newConversation = 'Alt+N';
    const first = await daemon.invoke('save_app_settings', { settings });
    await daemon.invoke('save_app_settings', { settings: { ...first.settings, plugins: { ...first.settings.plugins, review: { reviewAgent: 'workhorse' } } } });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });

    const restored = await daemon.invoke('load_app_settings');
    expect(restored).toMatchObject({
      plugins: { review: { reviewAgent: 'workhorse' }, 'web-search': { webSearchModel: 'anthropic/claude' } }, localEnabled: false, defaultThinking: 'high', defaultFastMode: true,
      modelAliases: { 'openai/gpt': 'Daily model' }, hiddenModels: ['openai/old'],
      contextWindowCap: 200_000, contextWindowCapEnabled: false,
      modelContextWindowCaps: { 'openai/gpt': 400_000, 'anthropic/claude': null },
      autoRetry: false, debugMode: true,
      hosts: [{ enabled: false, id: 'build', name: 'Build server', target: 'user@build', piPath: '~/bin/pi' }],
    });
    expect(restored.keybindings.newConversation).toBe('Alt+N');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('invalid per-model context caps are rejected and the saved settings stay unchanged after a restart', async () => {
  let daemon = await startDaemon();
  try {
    const settings = await daemon.invoke('load_app_settings');
    settings.modelContextWindowCaps = { 'openai/gpt': 400_000 };
    await daemon.invoke('save_app_settings', { settings });
    const before = await daemon.invoke('load_app_settings');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ gpt: 400_000 }, 'Context cap model "gpt" must be written as provider/model'],
      [{ 'openai/gpt': 99_999 }, 'Context cap for openai/gpt must be from 100,000 to 50,000,000 tokens'],
      [{ 'openai/gpt': 50_000_001 }, 'Context cap for openai/gpt must be from 100,000 to 50,000,000 tokens'],
      [{ 'openai/gpt': 150_000.5 }, 'modelContextWindowCaps'],
    ];
    for (const [caps, expected] of cases) {
      const invalid = { ...structuredClone(before), modelContextWindowCaps: caps };
      expect(await daemon.failure('save_app_settings', { settings: invalid }), expected).toContain(expected);
    }
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });
    expect(await daemon.invoke('load_app_settings')).toEqual(before);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('a rejected settings save preserves the revision and permits a corrected retry', async () => {
  const daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const baseline = await daemon.invoke('load_settings_change');
    const machine = { enabled: false, id: 'build', name: 'Build server', target: 'user@build;id', piPath: 'pi' };
    const invalid = { ...structuredClone(baseline.settings), plugins: { review: { reviewAgent: 'Rejected review prompt' } }, hosts: [machine] };
    expect(await daemon.failure('save_app_settings', { settings: invalid }))
      .toContain('SSH target may only contain a host, user, and port-safe characters');

    const after = await other.invoke('load_settings_change');
    expect(after.revision).toBe(baseline.revision);
    expect(after.settings).toEqual(baseline.settings);

    const corrected = { ...structuredClone(baseline.settings), plugins: { review: { reviewAgent: 'Corrected review prompt' } }, hosts: [{ ...machine, target: 'user@build' }] };
    const saved = await daemon.invoke('save_app_settings', { settings: corrected });
    expect(saved.committedRevision).toBe(baseline.revision + 1);
    const received = await other.waitEvent('pi://settings-changed', change => change.settings.plugins.review.reviewAgent === 'Corrected review prompt');
    expect(received.revision).toBe(saved.committedRevision);
    expect(received.settings.hosts).toEqual([{ ...machine, target: 'user@build' }]);
    expect(other.events.some(event => event.payload?.settings?.plugins.review.reviewAgent === 'Rejected review prompt')).toBe(false);
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('removed settings entries stay removed when a client with older settings reloads and saves', async () => {
  let daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const initial = await daemon.invoke('load_app_settings');
    Object.assign(initial, {
      modelAliases: { 'openai/gpt': 'Daily model', 'openai/old': 'Old model' },
      hosts: [
        { enabled: false, id: 'build', name: 'Build server', target: 'user@build', piPath: 'pi' },
        { enabled: false, id: 'retired', name: 'Retired server', target: 'user@retired', piPath: 'pi' },
      ],
    });
    await daemon.invoke('save_app_settings', { settings: initial });
    const stale = await other.invoke('load_app_settings');

    const current = await daemon.invoke('load_app_settings');
    current.modelAliases = { 'openai/gpt': 'Daily model' };
    current.hosts = current.hosts.filter((host: any) => host.id !== 'retired');
    const removal = await daemon.invoke('save_app_settings', { settings: current });
    const received = await other.waitEvent('pi://settings-changed', change => change.revision === removal.revision);
    const remaining = {
      modelAliases: { 'openai/gpt': 'Daily model' },
      hosts: [{ enabled: false, id: 'build', name: 'Build server', target: 'user@build', piPath: 'pi' }],
    };
    expect(received.settings.modelAliases).toEqual(remaining.modelAliases);
    expect(received.settings.hosts).toEqual(remaining.hosts);
    expect(await other.failure('save_app_settings', { settings: { ...stale, plugins: { ...stale.plugins, review: { reviewAgent: 'Edit from older settings' } } } }))
      .toContain('Settings changed in another window or client');

    const edit = await other.invoke('save_app_settings', { settings: { ...received.settings, plugins: { ...received.settings.plugins, review: { reviewAgent: 'Edit after reload' } } } });
    const returned = await daemon.waitEvent('pi://settings-changed', change => change.revision === edit.revision);
    const expected = { ...remaining, plugins: { ...remaining.plugins, review: { reviewAgent: 'Edit after reload' } } };
    expect(returned.settings).toMatchObject(expected);
    expect(returned.settings.modelAliases).toEqual(remaining.modelAliases);
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });
    const restored = await daemon.invoke('load_app_settings');
    expect(restored).toMatchObject(expected);
    expect(restored.modelAliases).toEqual(remaining.modelAliases);
  } finally { await daemon.stop(); }
}, 60_000);
