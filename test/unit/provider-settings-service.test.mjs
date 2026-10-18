import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderComponent, act, enterText, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { ProviderSettings } from '../../clients/ui/components/ProviderSettings.tsx';

/** The provider settings against a real test daemon whose host has no stored logins. */
async function providers(t) {
  const dom = installDom();
  let view;
  t.after(async () => { await view?.unmount(); clearMocks(); dom.restore(); });
  const daemon = await daemonClient(t);
  mockWindows('main');
  mockIPC((command, args) => { assert.equal(command, 'daemon_invoke'); return daemon.invoke(args.command, args.args); }, { shouldMockEvents: true });
  view = await renderComponent(ProviderSettings, { hosts: [] });
  const section = name => document.querySelector(`section.provider-group[aria-label="${name}"]`);
  await untilDom(() => section('DeepSeek'), 15000);
  const button = (name, text) => [...section(name).querySelectorAll('button')].find(item => item.textContent.startsWith(text));
  const panel = () => document.querySelector('[aria-label="Provider login"]');
  return { daemon, section, button, panel };
}

test('signing in with an API key saves it on the host, and removing the login clears it', async t => {
  const { daemon, section, button, panel } = await providers(t);
  assert.match(section('DeepSeek').textContent, /Not configured/);
  await act(async () => button('DeepSeek', 'Sign in').click());
  const key = await untilDom(() => panel()?.querySelector('input[type="password"]'), 10000);
  await enterText(key, 'sk-test-deepseek-key');
  await act(async () => panel().querySelector('button[type="submit"]').click());
  await untilDom(() => /Credentials saved on this host\./.test(panel()?.textContent ?? ''), 10000);
  await untilDom(() => /^DeepSeekConfigured/.test(section('DeepSeek').textContent), 10000);
  const stored = (await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'list', refreshModels: false } })).providers.find(provider => provider.id === 'deepseek');
  assert.equal(stored.storedType, 'api_key');

  await act(async () => button('DeepSeek', 'Remove saved login').click());
  await untilDom(() => /Not configured/.test(section('DeepSeek').textContent) && !button('DeepSeek', 'Remove saved login'), 10000);
});

test('a login can be cancelled, and the filter finds providers by name', async t => {
  const { section, button, panel } = await providers(t);
  await act(async () => button('Fireworks', 'Sign in').click());
  await untilDom(() => panel()?.querySelector('input[type="password"]'), 10000);
  await act(async () => [...panel().querySelectorAll('button')].find(item => item.textContent === 'Cancel login').click());
  await untilDom(() => /Login cancelled\./.test(panel()?.textContent ?? ''), 10000);
  assert.match(section('Fireworks').textContent, /Not configured/);

  const shown = () => [...document.querySelectorAll('section.provider-group')].map(item => item.getAttribute('aria-label'));
  await enterText(document.querySelector('[aria-label="Filter providers"]'), ' KIMI for ');
  assert.deepEqual(shown(), ['Kimi For Coding'], 'by name, ignoring case and spaces');
  await enterText(document.querySelector('[aria-label="Filter providers"]'), 'moonshotai-');
  assert.deepEqual(shown(), ['Moonshot AI CN'], 'by provider ID');
  await enterText(document.querySelector('[aria-label="Filter providers"]'), 'no such provider');
  await untilDom(() => /No providers match/.test(document.querySelector('.provider-settings').textContent), 15000);
});
