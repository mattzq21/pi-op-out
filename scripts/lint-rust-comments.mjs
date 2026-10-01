import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { licenseHeaderComments } from './comment-policy.mjs';
import { rustSourceFiles } from './rust-source-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const options = { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };

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

function main() {
  try {
    execFileSync('rust-code-analysis-cli', ['--version'], options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Install the Rust parser with: cargo install rust-code-analysis-cli --version 0.0.25 --locked');
  }

  const files = rustSourceFiles(options);

  if (files.length === 0) throw new Error('No Rust files found for comment checking');
  const failures = files.reduce((sum, file) => sum + checkFile(file), 0);
  console.log(`Rust comments: ${files.length} files checked, ${failures} forbidden comments.`);
  process.exitCode = failures > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
