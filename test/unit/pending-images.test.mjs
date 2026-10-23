import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom, renderComponent } from '../dom.mjs';
import { PendingImages } from '../../clients/ui/components/PendingImages.tsx';

test('a queued message shows a preview of each image, loaded once from the host', async t => {
  const dom = installDom();
  const loads = [];
  const load = async (id, index) => { loads.push([id, index]); return { data: 'QUFB' + index, mimeType: 'image/png' }; };
  const message = { id: 'queued-1', message: '', behavior: 'followUp', images: [{ type: 'image', mimeType: 'image/png' }, { type: 'image', mimeType: 'image/png', name: 'shot.png' }] };
  const view = await renderComponent(PendingImages, { message, load });
  t.after(async () => { await view.unmount(); dom.restore(); });
  assert.deepEqual([...view.container.querySelectorAll('img')].map(image => [image.getAttribute('src'), image.getAttribute('alt')]), [['data:image/png;base64,QUFB0', 'Attached image'], ['data:image/png;base64,QUFB1', 'shot.png']]);
  await view.rerender({ message: { ...message }, load });
  assert.deepEqual(loads, [['queued-1', 0], ['queued-1', 1]]);
});

test('a message still being sent shows its own image data, and an image that fails to load shows why', async t => {
  const dom = installDom();
  const sending = { id: 'sending-1', message: 'd', behavior: 'followUp', images: [{ type: 'image', mimeType: 'image/png', data: 'QkJC' }] };
  const view = await renderComponent(PendingImages, { message: sending, load: async () => { throw new Error('gone'); } });
  t.after(async () => { await view.unmount(); dom.restore(); });
  assert.equal(view.container.querySelector('img').getAttribute('src'), 'data:image/png;base64,QkJC');
  await view.rerender({ message: { id: 'queued-2', message: '', behavior: 'followUp', images: [{ type: 'image', mimeType: 'image/png' }] }, load: async () => { throw new Error('The image of this queued message is no longer available'); } });
  assert.match(view.container.querySelector('.pending-image-missing').dataset.tooltip, /no longer available/);
});
