import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { SkillMcpStatus } from '../../clients/ui/components/SkillMcpStatus.tsx';

test('failed skill MCP servers show their error and send Retry and Remove actions', async t => {
  const dom = installDom(), actions = [];
  const onAction = async (...args) => { actions.push(args); };
  const value = JSON.stringify([{ name: 'skill_123_app', label: 'desktop: app', state: 'failed', error: 'Server process exited' }]);
  const view = await renderComponent(SkillMcpStatus, { value, onAction });
  t.after(async () => { await view.unmount(); dom.restore(); });
  assert.match(view.container.querySelector('[role=alert]').textContent, /Server process exited/);
  const button = label => [...view.container.querySelectorAll('button')].find(button => button.textContent === label);
  await act(() => button('Retry').click()); await act(() => button('Remove').click());
  assert.deepEqual(actions, [['skill_123_app', 'retry'], ['skill_123_app', 'remove']]);
  await view.rerender({ value: JSON.stringify([{ name: 'skill_123_app', label: 'desktop: app', state: 'connected' }]), onAction });
  assert.equal(view.container.querySelector('section'), null);
});

test('retry errors remain visible and a connecting server can be removed', async t => {
  const dom = installDom();
  const onAction = async () => { throw new Error('Connection refused'); };
  const server = { name: 'skill_app', label: 'desktop: app', state: 'failed', error: 'offline' };
  const view = await renderComponent(SkillMcpStatus, { value: JSON.stringify([server]), onAction });
  t.after(async () => { await view.unmount(); dom.restore(); });
  await act(() => view.container.querySelector('button').click());
  assert.match(view.container.textContent, /Connection refused/);
  await view.rerender({ value: JSON.stringify([{ ...server, state: 'connecting' }]), onAction });
  assert.match(view.container.textContent, /Connecting/);
  assert.equal(view.container.querySelector('button').textContent, 'Remove');
  assert.equal(view.container.querySelector('button').disabled, false);
});

test('read-only skill MCP status has disabled actions', async t => {
  const dom = installDom();
  const view = await renderComponent(SkillMcpStatus, { value: JSON.stringify([{ name: 'skill_app', label: 'desktop: app', state: 'failed' }]), disabled: true, onAction: async () => { throw new Error('unexpected action'); } });
  t.after(async () => { await view.unmount(); dom.restore(); });
  assert.ok([...view.container.querySelectorAll('button')].every(button => button.disabled));
});
