import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/** A reply in a chat whose project is /work/project on the machine "server"; only shots/ok.png exists there. */
async function replyPage(t, content) {
  const reads = [];
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/message-project-images-browser.tsx', ready: 'article', holdStorage: false,
    prepare: async page => {
      await page.exposeFunction('messageContent', () => content);
      await page.exposeFunction('nativeCommand', async (command, args) => {
        if (command !== 'read_image_file') throw new Error('Unexpected command: ' + command);
        const { clientId, ...request } = args;
        reads.push(request);
        if (request.path === 'shots/ok.png') return PIXEL;
        throw new Error('No such file');
      });
    },
  });
  return { page, reads };
}

test('project images named in a reply show inside it, a missing one says so, and the thumbnail opens the image while the remote file link reports its host', async t => {
  const { page, reads } = await replyPage(t, 'The result is in `shots/ok.png`. Before: ![old run](shots/missing.png) ![](shots/gone.png). Code: `src/main.ts`.');
  await page.locator('img').waitFor();
  assert.equal(await page.locator('img').getAttribute('src'), PIXEL);
  await page.getByText('old run: Image unavailable', { exact: true }).waitFor();
  await page.getByText('shots/gone.png: Image unavailable', { exact: true }).waitFor();
  assert.match(await page.locator('.markdown-content').textContent(), /Before: \[Image: old run\] \[Image: shots\/gone\.png\]\./);
  assert.deepEqual(reads.map(read => read.path).sort(), ['shots/gone.png', 'shots/missing.png', 'shots/ok.png']);
  assert.ok(reads.every(read => read.cwd === '/work/project' && read.hostId === 'server'));
  assert.equal(await page.getByRole('button', { name: 'src/main.ts' }).count(), 0, 'paths to other files stay plain text');

  await page.getByRole('button', { name: 'shots/ok.png', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'This file is on the host "server"' }).waitFor();
  await page.getByRole('button', { name: 'Enlarge image: shots/ok.png', exact: true }).click();
  await page.getByRole('dialog', { name: 'shots/ok.png' }).waitFor();
});
