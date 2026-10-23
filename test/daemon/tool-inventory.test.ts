import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onToolsChanged, parseTools, recordTools, savedTools } from "../../daemon/src/tool_inventory";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function settingsFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'piop-tools-'));
  roots.push(root);
  return join(root, 'settings.json');
}

test('a host has no tools before Pi reports them, then keeps the latest report in name order', () => {
  const file = settingsFile();
  expect(savedTools(file)).toEqual([]);
  recordTools([
    { name: 'web_search', description: 'Search', source: '/ext/piop-codex-web-search.ts' },
    { name: 'read', description: 'Read files', source: 'builtin:read' },
  ], file);
  expect(savedTools(file).map(tool => tool.name)).toEqual(['read', 'web_search']);
  recordTools([{ name: 'bash', description: 'Run', source: 'builtin:bash' }], file);
  expect(savedTools(file)).toEqual([{ name: 'bash', description: 'Run', source: 'builtin:bash' }]);
});

test('listeners hear about a report only when the tools changed', () => {
  const file = settingsFile();
  let changes = 0;
  const stop = onToolsChanged(() => { changes += 1; });
  try {
    const report = [{ name: 'read', description: 'Read files', source: 'builtin:read' }];
    recordTools(report, file);
    recordTools(report, file);
    expect(changes).toBe(1);
    recordTools([{ ...report[0], description: 'Read text files' }], file);
    expect(changes).toBe(2);
  } finally { stop(); }
});

test('a malformed report is rejected and leaves the saved tools unchanged', () => {
  const file = settingsFile();
  recordTools([{ name: 'read', description: '', source: 'builtin:read' }], file);
  expect(() => recordTools([{ name: 'read', description: '', source: 'builtin:read' }, { name: 'read', description: '', source: 'builtin:read' }], file)).toThrow('reported the tool read twice');
  expect(() => recordTools([{ name: 'read', description: '' }], file)).toThrow('has no source');
  expect(() => parseTools({ name: 'read' })).toThrow('must be a list');
  expect(savedTools(file).map(tool => tool.name)).toEqual(['read']);
});
