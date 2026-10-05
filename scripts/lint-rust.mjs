import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { licenseHeaderComments } from './comment-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const options = { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };

const limit = 10;

const lineLimit = 750;

function rustSourceFiles(options) {
  const output = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.rs',
    ':(exclude)**/target/**',
  ], options);

  return [...new Set(output.split('\0').filter(Boolean))];
}

function lineOffsets(bytes) {
  const offsets = [0];

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) offsets.push(index + 1);
  }

  return offsets;
}

function commentAt(source, bytes, offsets, match) {
  const [, kind, row, column, endRow, endColumn] = match;
  const startByte = offsets[Number(row) - 1] + Number(column) - 1;
  const endByte = offsets[Number(endRow) - 1] + Number(endColumn) - 1;
  const start = bytes.subarray(0, startByte).toString('utf8').length;
  const end = bytes.subarray(0, endByte).toString('utf8').length;
  const text = source.slice(start, end);
  const block = kind === 'block_comment';

  if (!text.startsWith(block ? '/*' : '//')) throw new Error('Invalid Rust parser comment span');

  return { type: block ? 'Block' : 'Line', range: [start, end], value: text.slice(2, block ? -2 : undefined), row, column };
}

function parsedComments(file, source) {
  if (Buffer.byteLength(source) <= 3) {
    return source.startsWith('//') ? [{ type: 'Line', range: [0, source.length], value: source.slice(2), row: 1, column: 1 }] : [];
  }

  const output = execFileSync('rust-code-analysis-cli', ['-p', file, '-l', 'rust', '-f', 'comment'], options);
  const listing = stripVTControlCharacters(output);
  const pattern = /^╰─ \{(line_comment|block_comment):\d+\} from \((\d+), (\d+)\) to \((\d+), (\d+)\)/gmu;
  const bytes = Buffer.from(source);
  const offsets = lineOffsets(bytes);
  const comments = [...listing.matchAll(pattern)].map((match) => commentAt(source, bytes, offsets, match));

  if (listing.trim() && comments.length === 0) throw new Error(`Unrecognized Rust parser output for ${file}`);

  return comments;
}

function checkFile(file) {
  const source = readFileSync(resolve(root, file), 'utf8').replace(/^\uFEFF/u, '');
  const comments = parsedComments(file, source);
  const licenses = licenseHeaderComments(source, comments);
  let failures = 0;

  for (const comment of comments) {
    if (licenses.has(comment)) continue;
    console.error(`${file}:${comment.row}:${comment.column}: comments are not allowed except license headers, lint directives, and shebangs`);
    failures += 1;
  }

  return failures;
}

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

  const lines = ploc + blank;

  if (lines <= lineLimit) return 0;
  console.error(`${file}: ${lines} lines excluding comment-only lines (maximum ${lineLimit})`);

  return 1;
}

function checkComments(files) {
  const failures = files.reduce((sum, file) => sum + checkFile(file), 0);
  console.log(`Rust comments: ${files.length} files checked, ${failures} forbidden comments.`);

  return failures;
}

function checkComplexity(files) {
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

  return failures + oversizedFiles;
}

function main() {
  const { values } = parseArgs({ options: { only: { type: 'string' } } });

  if (values.only && !['comments', 'complexity'].includes(values.only)) throw new Error(`Unknown Rust lint check: ${values.only}`);

  try {
    execFileSync('rust-code-analysis-cli', ['--version'], options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Install the Rust parser with: cargo install rust-code-analysis-cli --version 0.0.25 --locked');
  }

  const files = rustSourceFiles(options);

  if (files.length === 0) throw new Error('No Rust files found for lint checking');
  const comments = values.only === 'complexity' ? 0 : checkComments(files);
  const complexity = values.only === 'comments' ? 0 : checkComplexity(files);
  process.exitCode = comments + complexity > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
