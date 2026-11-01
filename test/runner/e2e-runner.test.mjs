import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../../scripts/test-e2e.mjs', import.meta.url));

test('an unmatched E2E selection is reported before building the app', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'piop-e2e-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const specs = join(directory, 'test/e2e/specs');
  await mkdir(specs, { recursive: true });
  await writeFile(join(specs, 'conversation.acceptance.spec.ts'), "describe('chat', () => { it('opens', () => {}); });");
  const builds = join(directory, 'builds');
  await writeFile(join(directory, 'bun'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(builds)}, 'started');
process.exit(73);
`, { mode: 0o755 });
  await assert.rejects(execute(process.execPath, [runner, '--build', '--list', '--grep', '^missing$'],
    { cwd: directory, env: { ...process.env, PATH: directory + ':' + process.env.PATH } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /No E2E tests matched/);
    return true;
  });
  assert.equal(existsSync(builds), false, 'unmatched selections must not start builds');
});
