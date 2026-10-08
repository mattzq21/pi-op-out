const fs = require('node:fs');

function containerContents(directory, info = fs.lstatSync(directory, { bigint: true })) {
  if (!info.isDirectory()) return;
  const temporary = `.parent-v1-${info.dev}-${info.ino}.tmp`;
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  if (!entries.every(entry => entry.isFile() && (entry.name === 'parent.json' || entry.name === temporary))) return;

  return { pending: entries.some(entry => entry.name === temporary), files: entries.map(entry => entry.name) };
}

module.exports = { containerContents };
