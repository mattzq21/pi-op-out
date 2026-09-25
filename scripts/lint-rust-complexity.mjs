import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const limit = 10;
const lineLimit = 750;
const options = { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };

function checkSpace(space, file) {
  const children = space.spaces;
  const total = space.metrics.cyclomatic.sum;
  if (!Array.isArray(children) || !Number.isFinite(total)) {
    throw new Error(`Invalid complexity metrics for ${file}`);
  }
  const ownComplexity = total - children.reduce((sum, child) => sum + child.metrics.cyclomatic.sum, 0);
  let failures = 0;
  if (space.kind === 'function' && ownComplexity > limit) {
    console.error(`${file}:${space.start_line}: ${space.name ?? '<anonymous>'} has cyclomatic complexity ${ownComplexity} (maximum ${limit})`);
    failures += 1;
  }
  for (const child of children) failures += checkSpace(child, file);
  return failures;
}

function checkLines(space, file) {
  const { ploc, blank } = space.metrics.loc;
  if (!Number.isFinite(ploc) || !Number.isFinite(blank)) {
    throw new Error(`Invalid line metrics for ${file}`);
  }
  // Physical code lines plus blanks excludes only comment-only lines.
  const lines = ploc + blank;
  if (lines <= lineLimit) return 0;
  console.error(`${file}: ${lines} lines excluding comment-only lines (maximum ${lineLimit})`);
  return 1;
}

function main() {
  try {
    execFileSync('rust-code-analysis-cli', ['--version'], options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Install the Rust complexity tool with: cargo install rust-code-analysis-cli --version 0.0.25 --locked');
  }
  const files = [...new Set(execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.rs',
  ], options).split('\0').filter(Boolean))];
  if (files.length === 0) throw new Error('No Rust files found for complexity checking');
  let failures = 0;
  let oversizedFiles = 0;
  for (const file of files) {
    const output = execFileSync('rust-code-analysis-cli', ['-m', '-p', file, '-O', 'json'], options);
    const space = JSON.parse(output);
    failures += checkSpace(space, file);
    oversizedFiles += checkLines(space, file);
  }
  console.log(`Rust cyclomatic complexity: ${files.length} files checked, ${failures} functions exceed ${limit}.`);
  console.log(`Rust file length: ${files.length} files checked, ${oversizedFiles} files exceed ${lineLimit} lines excluding comment-only lines.`);
  process.exitCode = failures + oversizedFiles > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
