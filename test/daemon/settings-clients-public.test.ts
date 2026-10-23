import { expect, test } from 'bun:test';
import { startDaemon, synchronizationFinished, temporaryDirectory, type TestDaemon } from './harness';

test.concurrent('separate development daemons notify their clients when shared settings change', async () => {
  const home = temporaryDirectory('piop-settings-shared-');
  const running: TestDaemon[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const daemon = await startDaemon({ home, development: true, projectRoot: temporaryDirectory('piop-settings-project-') });
      running.push(daemon);
      const initial = await daemon.invoke('load_app_settings');
      initial.reviewAgent = 'Initial settings for project ' + index;
      const baseline = await daemon.invoke('save_app_settings', { settings: initial });
      await synchronizationFinished(daemon, baseline.revision);
    }
    const [first, second] = running as [TestDaemon, TestDaemon];
    const settings = await first.invoke('load_app_settings');
    settings.reviewAgent = 'Review changes from the first project';
    const saved = await first.invoke('save_app_settings', { settings });
    const received = await second.waitEvent('pi://settings-changed', change =>
      change.settings.reviewAgent === 'Review changes from the first project');
    expect(received.revision).toBe(saved.committedRevision);

    const next = await second.invoke('save_app_settings', {
      settings: { ...received.settings, reviewAgent: 'Review changes from the second project' },
    });
    const returned = await first.waitEvent('pi://settings-changed', change =>
      change.settings.reviewAgent === 'Review changes from the second project');
    expect(returned.revision).toBe(next.committedRevision);
    expect((await first.invoke('load_app_settings')).reviewAgent)
      .toBe('Review changes from the second project');
  } finally { await Promise.all(running.map(daemon => daemon.stop())); }
}, 60_000);

test.concurrent('separate development daemons sharing settings accept one simultaneous save and let the other retry after reloading', async () => {
  const home = temporaryDirectory('piop-settings-race-');
  const running: TestDaemon[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const daemon = await startDaemon({ home, development: true, projectRoot: temporaryDirectory('piop-settings-race-project-') });
      running.push(daemon);
      const initial = await daemon.invoke('load_app_settings');
      initial.reviewAgent = 'Initial settings for project ' + index;
      const baseline = await daemon.invoke('save_app_settings', { settings: initial });
      await synchronizationFinished(daemon, baseline.revision);
    }
    const daemons = running as [TestDaemon, TestDaemon];
    const latest = await daemons[1].invoke('load_settings_change');
    await daemons[0].waitEvent('pi://settings-changed', change => change.revision === latest.revision);
    const baselines = await Promise.all(daemons.map(daemon => daemon.invoke('load_settings_change')));
    expect(baselines[0].revision).toBe(baselines[1].revision);
    expect(baselines[0].settings).toEqual(baselines[1].settings);

    const prompts = ['Review correctness from the first project', 'Review reliability from the second project'];
    const results = await Promise.allSettled(daemons.map((daemon, index) =>
      daemon.invoke('save_app_settings', { settings: { ...structuredClone(baselines[index].settings), reviewAgent: prompts[index] } })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const loser = results.findIndex(result => result.status === 'rejected');
    const winner = 1 - loser;
    expect((results[loser] as PromiseRejectedResult).reason.message).toContain('Settings changed in another window or client');
    const accepted = (results[winner] as PromiseFulfilledResult<any>).value;
    await daemons[loser]!.waitEvent('pi://settings-changed', change => change.revision === accepted.committedRevision);
    for (const daemon of daemons) {
      const visible = await daemon.invoke('load_settings_change');
      expect(visible.revision).toBe(accepted.committedRevision);
      expect(visible.settings.reviewAgent).toBe(prompts[winner]);
    }

    const reloaded = await daemons[loser]!.invoke('load_app_settings');
    reloaded.reviewAgent = 'Review correctness and reliability from both projects';
    const retried = await daemons[loser]!.invoke('save_app_settings', { settings: reloaded });
    expect(retried.committedRevision).toBe(accepted.committedRevision + 1);
    await daemons[winner]!.waitEvent('pi://settings-changed', change => change.revision === retried.committedRevision);
    for (const daemon of daemons) {
      const visible = await daemon.invoke('load_settings_change');
      expect(visible.revision).toBe(retried.committedRevision);
      expect(visible.settings.reviewAgent).toBe('Review correctness and reliability from both projects');
    }
  } finally { await Promise.all(running.map(daemon => daemon.stop())); }
}, 60_000);

test.concurrent('saved settings survive a daemon restart and the saved version remains editable', async () => {
  let daemon = await startDaemon();
  try {
    const settings = await daemon.invoke('load_app_settings');
    settings.reviewAgent = 'Check that user data survives failures';
    const saved = await daemon.invoke('save_app_settings', { settings });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });

    const restored = await daemon.invoke('load_settings_change');
    expect(restored.settings.reviewAgent).toBe('Check that user data survives failures');
    expect(restored.revision).toBe(saved.committedRevision);
    expect(restored.settings.settingsRevision).toBe(saved.settings.settingsRevision);
    const next = await daemon.invoke('save_app_settings', {
      settings: { ...saved.settings, reviewAgent: 'Check recovery after a second save' },
    });
    expect(next.committedRevision).toBe(saved.committedRevision + 1);
    expect((await daemon.invoke('load_app_settings')).reviewAgent)
      .toBe('Check recovery after a second save');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('simultaneous settings saves accept one client and let the other retry after reloading', async () => {
  const daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const clients = [daemon, other];
    const settings = await Promise.all(clients.map(client => client.invoke('load_app_settings')));
    settings[0].reviewAgent = 'Review correctness';
    settings[1].reviewAgent = 'Review reliability';
    const results = await Promise.allSettled(clients.map((client, index) =>
      client.invoke('save_app_settings', { settings: settings[index] })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.findIndex(result => result.status === 'rejected');
    const failure = results[rejected] as PromiseRejectedResult;
    expect(failure.reason.message).toContain('Settings changed in another window or client');
    const saved = await clients[rejected]!.invoke('load_app_settings');
    expect(saved.reviewAgent).toBe(settings[1 - rejected].reviewAgent);

    saved.reviewAgent = 'Review correctness and reliability';
    await clients[rejected]!.invoke('save_app_settings', { settings: saved });
    expect((await clients[1 - rejected]!.invoke('load_app_settings')).reviewAgent)
      .toBe('Review correctness and reliability');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('another connected client receives saved settings and can edit that received version', async () => {
  const daemon = await startDaemon();
  try {
    const other = await daemon.connect();
    const settings = await daemon.invoke('load_app_settings');
    settings.reviewAgent = 'Check failure recovery';
    const saved = await daemon.invoke('save_app_settings', { settings });
    const received = await other.waitEvent('pi://settings-changed', change =>
      change.settings.reviewAgent === 'Check failure recovery');
    expect(received.settings).toEqual(saved.settings);
    expect(received.revision).toBe(saved.revision);

    const edited = { ...received.settings, reviewAgent: 'Check recovery and data preservation' };
    await other.invoke('save_app_settings', { settings: edited });
    const returned = await daemon.waitEvent('pi://settings-changed', change =>
      change.settings.reviewAgent === 'Check recovery and data preservation');
    expect(returned.settings.reviewAgent).toBe('Check recovery and data preservation');
    expect((await daemon.invoke('load_app_settings')).reviewAgent)
      .toBe('Check recovery and data preservation');
  } finally { await daemon.stop(); }
}, 60_000);

test.concurrent('a save that edits one setting keeps every other saved setting across a daemon restart', async () => {
  let daemon = await startDaemon();
  try {
    const settings = await daemon.invoke('load_app_settings');
    Object.assign(settings, {
      reviewAgent: 'reviewer', localEnabled: false, defaultThinking: 'high', defaultFastMode: true,
      modelAliases: { 'openai/gpt': 'Daily model' }, hiddenModels: ['openai/old'],
      contextWindowCap: 200_000, contextWindowCapEnabled: false,
      modelContextWindowCaps: { 'openai/gpt': 400_000, 'anthropic/claude': null },
      autoRetry: false, debugMode: true,
      hosts: [{ enabled: false, id: 'build', name: 'Build server', target: 'user@build', piPath: '~/bin/pi' }],
    });
    settings.keybindings.newConversation = 'Alt+N';
    const first = await daemon.invoke('save_app_settings', { settings });
    await daemon.invoke('save_app_settings', { settings: { ...first.settings, reviewAgent: 'workhorse' } });
    const home = daemon.home;
    await daemon.stop();
    daemon = await startDaemon({ home });

    const restored = await daemon.invoke('load_app_settings');
    expect(restored).toMatchObject({
      reviewAgent: 'workhorse', localEnabled: false, defaultThinking: 'high', defaultFastMode: true,
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
    const invalid = { ...structuredClone(baseline.settings), reviewAgent: 'Rejected review prompt', hosts: [machine] };
    expect(await daemon.failure('save_app_settings', { settings: invalid }))
      .toContain('SSH target may only contain a host, user, and port-safe characters');

    const after = await other.invoke('load_settings_change');
    expect(after.revision).toBe(baseline.revision);
    expect(after.settings).toEqual(baseline.settings);

    const corrected = { ...structuredClone(baseline.settings), reviewAgent: 'Corrected review prompt', hosts: [{ ...machine, target: 'user@build' }] };
    const saved = await daemon.invoke('save_app_settings', { settings: corrected });
    expect(saved.committedRevision).toBe(baseline.revision + 1);
    const received = await other.waitEvent('pi://settings-changed', change => change.settings.reviewAgent === 'Corrected review prompt');
    expect(received.revision).toBe(saved.committedRevision);
    expect(received.settings.hosts).toEqual([{ ...machine, target: 'user@build' }]);
    expect(other.events.some(event => event.payload?.settings?.reviewAgent === 'Rejected review prompt')).toBe(false);
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
    expect(await other.failure('save_app_settings', { settings: { ...stale, reviewAgent: 'Edit from older settings' } }))
      .toContain('Settings changed in another window or client');

    const edit = await other.invoke('save_app_settings', { settings: { ...received.settings, reviewAgent: 'Edit after reload' } });
    const returned = await daemon.waitEvent('pi://settings-changed', change => change.revision === edit.revision);
    const expected = { ...remaining, reviewAgent: 'Edit after reload' };
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
