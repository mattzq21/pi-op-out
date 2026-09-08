const fs = require("node:fs");
const path = require("node:path");
const home = require("node:os").homedir();
const target = JSON.parse(process.argv[1]);
const root = target.root || path.join(home, ".piop", "sessions");
if (!fs.existsSync(root)) process.exit(0);
const realRoot = fs.realpathSync(root);
const candidates = target.path ? [target.path] : target.id
  ? fs.readdirSync(root).filter(name => name.endsWith(`_${target.id}.jsonl`)).map(name => path.join(root, name)) : [];
for (const candidate of candidates) {
  if (!fs.existsSync(candidate)) continue;
  const file = fs.realpathSync(candidate);
  if (path.dirname(file) !== realRoot || !file.endsWith(".jsonl")) continue;
  let entries;
  try { entries = fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(JSON.parse); }
  catch { continue; } // Incomplete or unrecognised data must be retained.
  const header = entries[0];
  if (header?.type !== "session" || !header.id || (target.id && header.id !== target.id)) continue;
  if (entries.some(entry => entry.type === "message")) continue;
  fs.unlinkSync(file);
  const sidecar = file.replace(/\.jsonl$/, ".diffs.json");
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
}
