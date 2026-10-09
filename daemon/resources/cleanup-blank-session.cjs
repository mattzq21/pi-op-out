const fs = require("node:fs");
const path = require("node:path");

const home = require("node:os").homedir();

const target = JSON.parse(process.argv[1]);

const root = target.root || path.join(home, process.env.PIOP_STORAGE_DIRECTORY || ".piop", "sessions");

if (!fs.existsSync(root)) process.exit(0);

const realRoot = fs.realpathSync(root);

const registered = !target.path && target.id ? require('./session-database.cjs').lookup(path.dirname(realRoot), target.id) : undefined;

const candidates = target.path ? [target.path] : registered ? [registered] : [];

for (const candidate of candidates) {
  if (!fs.existsSync(candidate)) continue;
  const file = fs.realpathSync(candidate);

  if (path.dirname(file) !== realRoot || !file.endsWith(".jsonl")) continue;
  let entries;

  try { entries = fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(JSON.parse); }
  catch { continue; }

  const header = entries[0];

  if (header?.id === '00000000-0000-4000-8000-000000000001') continue;

  if (header?.type !== "session" || !header.id || (target.id && header.id !== target.id)) continue;

  if (entries.some(entry => entry.type === "message")) continue;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header.id)
    && require('./session-database.cjs').queuedInput(path.dirname(realRoot), header.id) !== undefined) continue;
  fs.unlinkSync(file);
  const sidecar = file.replace(/\.jsonl$/, ".diffs.json");

  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  const loopCheckpoint = `${file}.loop-detection.json`;

  if (fs.existsSync(loopCheckpoint)) fs.unlinkSync(loopCheckpoint);
  const database = require('./session-database.cjs').open(path.dirname(realRoot));

  try {
    database.exec('BEGIN IMMEDIATE');

    for (const table of ['session_diff_state', 'session_diff_transfers']) {
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) database.prepare(`DELETE FROM ${table} WHERE session_id=lower(?)`).run(header.id);
    }

    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_references'").get()) database.prepare('DELETE FROM transcript_references WHERE session_id=lower(?) AND session_path=?').run(header.id, file);
    database.prepare('DELETE FROM sessions WHERE session_id=lower(?) AND session_path=?').run(header.id, file);
    database.exec('COMMIT');
  } finally { database.close(); }
}
