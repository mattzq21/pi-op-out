const fs = require('node:fs');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { homedir } = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function referencePublication(destination) {
  const root = path.join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(root, 'reference-publication.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid reference publication lock');
    const locked = spawnSync('flock', ['--shared', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    if (locked.error) throw locked.error;

    if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || 'Could not lock reference publication');
    registerTranscript(root, path.resolve(destination));

    return () => fs.closeSync(descriptor);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function registerTranscript(root, destination) {
  const file = path.join(root, 'sessions.sqlite');
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  const database = new (require('node:sqlite').DatabaseSync)(file);

  try {
    fs.chmodSync(file, 0o600);
    database.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)');
    database.prepare('INSERT INTO external_transcripts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json')
      .run(createHash('sha256').update(destination).digest('hex'), JSON.stringify({ path: destination }));
  } finally { database.close(); }
}

async function copyThroughLeaf(source, output, id, leafId) {
  let copiedHeader = false;
  const input = fs.createReadStream(source);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let found = false;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);

      if (!copiedHeader) {
        if (value.type !== 'session') throw Error('Invalid session header');
        await output.writeFile(JSON.stringify({ ...value, id, parentSession: source, timestamp: new Date().toISOString() }) + '\n');
        copiedHeader = true;

        if (leafId === '') { found = true; break; }
      } else {
        await output.writeFile(line + '\n');

        if (value.id === leafId) { found = true; break; }
      }
    }
  } finally { lines.close(); input.destroy(); }

  if (!found) throw Error('The requested conversation leaf is unavailable');
}

(async () => {
  const [source, destination, id, leafId] = process.argv.slice(1);
  const release = referencePublication(destination);

  try { await copySession(source, destination, id, leafId); }
  finally { release(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

async function copySession(source, destination, id, leafId) {
  const output = await fs.promises.open(destination, 'wx', 0o600); let header = Buffer.alloc(0), copiedHeader = false;

  try {
    if (leafId !== undefined) {
      await copyThroughLeaf(source, output, id, leafId);
      await output.close();

      return;
    }

    for await (const chunk of fs.createReadStream(source)) {
      if (copiedHeader) { await output.writeFile(chunk); continue; }

      header = Buffer.concat([header, chunk]); const newline = header.indexOf(10);

      if (newline < 0) continue;
      const value = JSON.parse(header.subarray(0, newline).toString());

      if (value.type !== 'session') throw Error('Invalid session header');
      await output.writeFile(JSON.stringify({ ...value, id, parentSession: source, timestamp: new Date().toISOString() }) + '\n');
      await output.writeFile(header.subarray(newline + 1)); header = undefined; copiedHeader = true;
    }

    if (!copiedHeader) throw Error('Missing session header');
  } catch (error) { await output.close(); await fs.promises.rm(destination, { force: true }); throw error; }

  await output.close();
}
