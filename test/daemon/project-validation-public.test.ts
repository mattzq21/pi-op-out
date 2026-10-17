import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from './harness';

test('project selection rejects links into app storage but accepts similarly named folders', async () => {
  const daemon = await startDaemon();
  try {
    for (const name of ['.piop', '.piop-dev']) {
      const storage = join(daemon.home, name);
      const child = join(storage, 'project');
      const alias = join(daemon.home, name + '-link');
      const sibling = join(daemon.home, name + '-project');
      mkdirSync(child, { recursive: true });
      mkdirSync(sibling);
      symlinkSync(child, alias);
      for (const path of [storage, child, alias]) {
        expect(await daemon.failure('validate_project_directory', { hostId: 'local', path }))
          .toBe('Piop storage directories cannot be selected as projects');
      }
      expect(await daemon.invoke('validate_project_directory', { hostId: 'local', path: sibling })).toBe(sibling);
    }
  } finally { await daemon.stop(); }
}, 60_000);
