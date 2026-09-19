import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin';

function testFiles() {
  return ['unit', 'extensions', 'mobile'].flatMap(dir => readdirSync(`test/${dir}`)
    .filter(name => name.endsWith('.test.mjs')).map(name => `test/${dir}/${name}`));
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function runFile(file, timeout, extraEnv) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [
      '--max-old-space-size=768', '--import', './test/mutation-coverage.mjs',
      '--import', './test/register-typescript.mjs', '--test', '--test-isolation=none', file,
    ], { detached: true, env: { ...process.env, ...extraEnv, PIOP_MUTATION_TEST: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const capture = chunk => { output = (output + chunk).slice(-32_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      killGroup(child);
      resolve({ code, output, timedOut, duration: Date.now() - start });
    });
  });
}

class NodeMutationRunner {
  static inject = [];
  capabilities() { return { reloadEnvironment: true }; }

  async dryRun() {
    const dir = mkdtempSync(join(tmpdir(), 'piop-mutant-coverage-'));
    const tests = [], mutantCoverage = { static: {}, perTest: {} };
    try {
      for (const file of testFiles()) {
        const output = join(dir, 'coverage.json');
        rmSync(output, { force: true });
        const result = await runFile(file, 30_000, { PIOP_MUTATION_COVERAGE: output, __STRYKER_ACTIVE_MUTANT__: '' });
        if (result.timedOut) return { status: 'timeout', reason: file };
        if (result.code !== 0) return { status: 'error', errorMessage: `${file}\n${result.output}` };
        const coverage = JSON.parse(readFileSync(output, 'utf8'));
        mutantCoverage.perTest[file] = { ...coverage.static, ...coverage.perTest[file] };
        tests.push({ id: file, name: file, fileName: file, status: 'success', timeSpentMs: result.duration });
      }
      return { status: 'complete', tests, mutantCoverage };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  async mutantRun({ activeMutant, testFilter, timeout }) {
    const deadline = Date.now() + Math.min(timeout, 30_000);
    let nrOfTests = 0;
    for (const file of testFilter ?? testFiles()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout' };
      const result = await runFile(file, remaining, { __STRYKER_ACTIVE_MUTANT__: activeMutant.id, PIOP_MUTATION_COVERAGE: '' });
      nrOfTests += 1;
      if (result.timedOut) return { status: 'timeout' };
      if (result.code !== 0) return { status: 'killed', killedBy: [file], failureMessage: result.output, nrOfTests };
    }
    return { status: 'survived', nrOfTests };
  }
}

class CheckpointReporter {
  static inject = [];
  constructor() { mkdirSync('reports/mutation', { recursive: true }); }
  onDryRunCompleted(event) {
    writeFileSync('reports/mutation/remaining-typescript-coverage.json', JSON.stringify(event.result));
  }
  onMutationTestingPlanReady(event) {
    writeFileSync('reports/mutation/remaining-typescript-plan.json', JSON.stringify(event));
    writeFileSync('reports/mutation/remaining-typescript-results.jsonl', '');
  }
  onMutantTested(result) {
    appendFileSync('reports/mutation/remaining-typescript-results.jsonl', `${JSON.stringify(result)}\n`);
  }
}

export const strykerPlugins = [
  declareClassPlugin(PluginKind.TestRunner, 'piop-node', NodeMutationRunner),
  declareClassPlugin(PluginKind.Reporter, 'piop-checkpoint', CheckpointReporter),
];
