import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

/** A server that records every request a preview makes to the outside. */
async function outside(t) {
  const requests = [];
  const server = createServer((request, response) => { requests.push(request.url); response.setHeader('access-control-allow-origin', '*'); response.end('leaked'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

const open = (t, details) => startupPage(t, 'development', { entryPoint: 'test/fixtures/html-preview-browser.tsx', ready: 'main', holdStorage: false,
  prepare: page => page.exposeFunction('previewDetails', () => details) });

test('an HTML preview runs its own script, but cannot reach the app or the network', async t => {
  const server = await outside(t);
  const html = `<p id="out">waiting</p><img src="${server.url}/image.png"><link rel="stylesheet" href="${server.url}/style.css"><script>
    document.getElementById('out').textContent = 'script ran';
    try { parent.document.title = 'changed'; } catch {}
    try { top.document.title = 'changed'; } catch {}
    fetch('${server.url}/fetch').catch(() => {});
    new Image().src = '${server.url}/beacon';
  </script>`;
  const page = await open(t, { version: 1, html, title: 'Sales chart' });
  const content = page.frameLocator('iframe[title="Sales chart"]').frameLocator('iframe[title="HTML preview content"]');
  await content.getByText('script ran').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.title(), 'Piop');
  assert.deepEqual(server.requests, []);
  assert.equal(await page.getByRole('region', { name: 'Sales chart' }).count(), 1);
});

test('a preview the app cannot read says it is unavailable', async t => {
  const page = await open(t, { version: 1, html: '', title: 'Empty' });
  await page.getByText('HTML preview is unavailable.').waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
});
