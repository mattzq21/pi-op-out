import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

/** An OpenAI-compatible server on this machine that lists one model and records the keys it receives. */
async function modelServer(t) {
  const keys = [];
  const server = createServer((request, response) => {
    keys.push(request.headers.authorization);
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ object: 'list', data: [{ id: 'llama-test', object: 'model' }] })); return; }
    response.statusCode = 404; response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, keys };
}

const field = label => [...document.querySelectorAll('.custom-provider-form label')].find(item => item.querySelector('span')?.textContent === label).querySelector('input');

test('a custom provider added in settings finds its models with its key and shows as configured', async t => {
  const { daemon, section } = await providers(t);
  const server = await modelServer(t);
  await act(async () => document.querySelector('.provider-add-custom').click());
  await enterText(field('Provider ID'), 'local-llm');
  await enterText(field('Display name'), 'Local LLM');
  await enterText(field('API base URL'), server.url);
  await enterText(field('API key'), 'local-key');
  await act(async () => document.querySelector('.custom-provider-form button[type="submit"]').click());
  const added = await untilDom(() => [...document.querySelectorAll('[role="status"]')].find(item => /Custom provider added/.test(item.textContent)), 15000);
  assert.ok(server.keys.includes('Bearer local-key'));
  await act(async () => [...added.querySelectorAll('button')].find(item => item.textContent === 'Done').click());
  await untilDom(() => section('Local LLM') && /Configured/.test(section('Local LLM').textContent), 10000);
  const listed = (await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'list', refreshModels: false } })).providers.find(provider => provider.id === 'local-llm');
  assert.equal(listed.name, 'Local LLM');
});

test('a custom provider that cannot be reached is not added, and the form keeps what was typed', async t => {
  const { section } = await providers(t);
  await act(async () => document.querySelector('.provider-add-custom').click());
  await enterText(field('Provider ID'), 'gone-llm');
  await enterText(field('API base URL'), 'http://127.0.0.1:9/v1');
  await act(async () => document.querySelector('.custom-provider-form input[type="checkbox"]').click());
  await act(async () => document.querySelector('.custom-provider-form button[type="submit"]').click());
  const error = await untilDom(() => document.querySelector('.provider-settings > [role="alert"]'), 15000);
  assert.equal(error.textContent, 'Could not discover models. Check the API URL and connectivity from the selected host.');
  assert.equal(field('Provider ID').value, 'gone-llm');
  assert.equal(field('API base URL').value, 'http://127.0.0.1:9/v1');
  assert.equal(section('gone-llm'), null);
});
