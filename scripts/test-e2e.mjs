import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const { values } = parseArgs({ options: { grep: { type: 'string' }, list: { type: 'boolean' } } });
const file = 'test/e2e/specs/conversation.acceptance.spec.ts';
const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
const titles = [];
function collect(node, parents = []) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
    const name = node.expression.text;
    const title = [...parents, node.arguments[0].text];
    if (name === 'it') { titles.push(title.join(' ')); return; }
    if (name === 'describe') { collect(node.arguments[1], title); return; }
  }
  ts.forEachChild(node, child => collect(child, parents));
}
collect(source);
const selected = values.grep ? titles.filter(title => new RegExp(values.grep).test(title)) : titles;
if (!selected.length) throw new Error('No E2E tests matched');
if (values.list) {
  console.log(selected.join('\n'));
} else {
  let failed = false;
  const batchSize = 5;
  for (let start = 0; start < selected.length; start += batchSize) {
    const batch = selected.slice(start, start + batchSize);
    const pattern = `^(?:${batch.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
    console.log(`E2E batch ${Math.floor(start / batchSize) + 1}: tests ${start + 1}–${start + batch.length} of ${selected.length}`);
    const child = spawn(process.execPath, ['--max-old-space-size=768', 'node_modules/@wdio/cli/bin/wdio.js', 'run', 'wdio.conf.ts', '--mochaOpts.grep', pattern], { stdio: 'inherit' });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    if (result.signal) throw new Error(`E2E runner terminated by ${result.signal}`);
    if (result.code !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
