import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { detectFileLinks } from '../../clients/ui/lib/fileLinks.ts';
import { messageFilePath, openablePath } from '../../clients/ui/lib/messageFiles.ts';

test('plain absolute and ~ paths in a reply become file links; other words stay text', t => {
  const dom = installDom();
  t.after(() => dom.restore());
  const html = detectFileLinks('<p>See /home/me/app.py:12, ~/notes/todo.md and ~/.config/piop. Not and/or, src/a.ts or https://x.dev.</p><p><code>/etc/hosts</code></p>', openablePath);
  const template = document.createElement('template');
  template.innerHTML = html;
  const links = [...template.content.querySelectorAll('button.file-link')].map(link => link.dataset.fileReference);
  assert.deepEqual(links, ['/home/me/app.py:12', '~/notes/todo.md', '~/.config/piop', '/etc/hosts']);
});

test('a ~ path keeps its ~ for the desktop shell to resolve, and other paths resolve as before', () => {
  assert.equal(messageFilePath('~/notes/todo.md:3', undefined), '~/notes/todo.md');
  assert.equal(messageFilePath('src/a.ts', '/repo'), '/repo/src/a.ts');
  assert.equal(openablePath('~user/x'), false);
});
