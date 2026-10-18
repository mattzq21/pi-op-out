import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

// test/chatgpt-recovery-proof.mjs drives the bundled ChatGPT plugin through send, outage and recovery cases.
test('ChatGPT sends survive outages and lost replies: uncertain sends recover, stopped ones stay stopped', () => {
  const run = Bun.spawnSync([process.execPath, fileURLToPath(new URL('../chatgpt-recovery-proof.mjs', import.meta.url))], { stdout: 'pipe', stderr: 'pipe' });
  const output = run.stdout.toString() + run.stderr.toString();
  expect(output, output).not.toContain('FAIL');
  expect(run.exitCode, output).toBe(0);
  expect(output.match(/^PASS: /gm)?.length, output).toBeGreaterThanOrEqual(6);
}, 120000);
