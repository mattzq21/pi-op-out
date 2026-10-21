import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDom, renderComponent, act, untilDom } from '../dom.mjs';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { daemonClient } from '../daemon-client.mjs';
import { RefreshSkills } from '../../clients/ui/components/RefreshResources.tsx';

async function skillsHost(t) {
  const dom = installDom();
  let view;
  t.after(async () => { await view?.unmount(); clearMocks(); dom.restore(); });
  const daemon = await daemonClient(t);
  const root = join(await daemon.invoke('home_directory', { hostId: 'local' }), '.agents/skills');
  const write = (name, description) => { mkdirSync(join(root, name), { recursive: true }); writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody`); };
  mockWindows('main');
  mockIPC((command, args) => { assert.equal(command, 'daemon_invoke'); return daemon.invoke(args.command, args.args); }, { shouldMockEvents: true });
  const changes = [];
  const render = async props => { view = await renderComponent(RefreshSkills, { onChange: skills => changes.push(skills), ...props }); };
  const button = () => document.querySelector('button');
  return { root, write, render, changes, button };
}

test('refreshing skills finds new and removed skills on the host and keeps which ones were switched off', async t => {
  const { root, write, render, changes, button } = await skillsHost(t);
  write('review-code', 'Reviews code');
  write('write-tests', 'Writes tests');
  // Before the refresh the settings knew review-code, switched off, and a skill that is no longer on disk.
  await render({ hostId: 'local', skills: [
    { name: 'review-code', path: join(root, 'review-code'), description: 'Reviews code', enabled: false, userInvokedOnly: false },
    { name: 'gone', path: join(root, 'gone'), description: 'Removed', enabled: true, userInvokedOnly: false },
  ] });
  await act(async () => button().click());
  await untilDom(() => changes.length === 1, 10000);
  assert.deepEqual(changes[0].map(skill => [skill.name, skill.enabled]).sort(), [['review-code', false], ['write-tests', true]]);
  assert.equal(button().getAttribute('aria-label'), 'Refresh skills');
});

test('a refresh that fails says why and changes nothing', async t => {
  const { render, changes, button } = await skillsHost(t);
  await render({ hostId: 'missing-machine', skills: [] });
  await act(async () => button().click());
  const alert = await untilDom(() => document.querySelector('[role="alert"]'), 10000);
  assert.equal(alert.textContent, 'Unknown host: missing-machine');
  assert.deepEqual(changes, []);
  assert.equal(button().disabled, false);
});
