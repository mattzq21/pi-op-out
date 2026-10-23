import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webUrl } from '../../clients/ui/lib/webLinks.ts';

test('script and other non-web links never open, however they are disguised', () => {
  for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', ' \tjava\nscript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'vbscript:x', 'mailto:a@b.com', '/local/file', 'notes.md']) {
    assert.equal(webUrl(href), undefined, href);
  }
});

test('bare web addresses open as https', () => {
  assert.equal(webUrl('www.example.org/docs'), 'https://www.example.org/docs');
  assert.equal(webUrl('github.com/user/repo?tab=readme'), 'https://github.com/user/repo?tab=readme');
  assert.equal(webUrl('//cdn.example.com/x.js'), 'https://cdn.example.com/x.js');
  assert.equal(webUrl('http://192.168.1.4:8080'), 'http://192.168.1.4:8080/');
});
