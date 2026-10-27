import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComponent, createSignal } from 'solid-js';
import { act, installDom, renderComponent } from '../dom.mjs';
import { SidepaneTabs } from '../../clients/ui/components/SidepaneTabs.tsx';

const tab = (key, running) => ({ key, kind: 'btw', label: key, running, session: { id: key, hostId: 'local', name: key, path: '/' + key, project: 'p', cwd: '/p', preview: '', messageCount: 0, lastMessageAt: 0, apiCost: 0 } });

test('a focused tab keeps its button and focus when its chat starts or stops working, and arrow keys still move', async t => {
  const dom = installDom();
  let setTabs;
  const selected = [];
  const view = await renderComponent(() => {
    const [tabs, set] = createSignal([tab('first', true), tab('second', false)]);
    setTabs = set;
    return createComponent(SidepaneTabs, { get tabs() { return tabs(); }, selected: 'first', onSelect: key => selected.push(key), onClose: () => {}, children: [] });
  });
  t.after(async () => { await view.unmount(); dom.restore(); });
  const button = document.getElementById('sidepane-tab-first');
  button.focus();
  await act(() => setTabs([tab('first', false), tab('second', false)]));
  assert.equal(document.getElementById('sidepane-tab-first'), button);
  assert.equal(document.activeElement, button);
  assert.equal(button.querySelector('.sidepane-dot'), null);
  await act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  assert.deepEqual(selected, ['second']);
});
